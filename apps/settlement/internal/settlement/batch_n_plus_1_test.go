package settlement

import (
	"context"
	"encoding/json"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/money"
)

// statementCounter counts every statement a pool sends (BEGIN/COMMIT too).
type statementCounter struct{ n atomic.Int64 }

func (c *statementCounter) TraceQueryStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryStartData) context.Context {
	c.n.Add(1)
	return ctx
}
func (c *statementCounter) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func countingPool(t *testing.T) (*pgxpool.Pool, *statementCounter) {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping DB-backed test")
	}
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatalf("parse DATABASE_URL: %v", err)
	}
	counter := &statementCounter{}
	cfg.ConnConfig.Tracer = counter
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool, counter
}

// N+1: the nightly run sent ~24 statements per merchant, including the
// ~95 % of merchants with no activity at all. Idle merchants' zero batches
// are now written set-based.
func TestRunDailyBatch_IdleMerchantsCostConstantStatements(t *testing.T) {
	plain := mustPool(t)
	pool, counter := countingPool(t)
	ctx := context.Background()
	day := time.Date(2025, 11, 9, 0, 0, 0, 0, time.UTC)

	for i := 0; i < 60; i++ {
		insertActiveMerchant(t, plain, 250)
	}

	counter.n.Store(0)
	report, err := RunDailyBatch(ctx, pool, day, nil)
	if err != nil {
		t.Fatalf("RunDailyBatch: %v", err)
	}
	if len(report.MerchantResults) < 60 {
		t.Fatalf("report has %d merchants, want at least the 60 idle ones", len(report.MerchantResults))
	}
	if got := counter.n.Load(); got > 400 {
		t.Fatalf("RunDailyBatch sent %d statements for %d merchants: idle merchants must not cost a round trip each",
			got, len(report.MerchantResults))
	}
}

// The set-based zero batch must leave exactly what the per-merchant path
// leaves for an idle merchant.
func TestRunDailyBatch_IdleBatchMatchesThePerMerchantPath(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	day := time.Date(2025, 11, 10, 0, 0, 0, 0, time.UTC)
	viaCloseBatch := insertActiveMerchant(t, pool, 250)
	viaDailyRun := insertActiveMerchant(t, pool, 250)

	closed, err := CloseBatch(ctx, pool, viaCloseBatch, day)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if _, err := PayoutBatch(ctx, pool, closed.BatchID); err != nil {
		t.Fatalf("PayoutBatch: %v", err)
	}
	if _, err := RunDailyBatch(ctx, pool, day, nil); err != nil {
		t.Fatalf("RunDailyBatch: %v", err)
	}

	type outcome struct {
		Status                string
		Gross, Fee, Net       int64
		HasClosedAt, HasPaid  bool
		ClosedEvents          int
		PaidEvents            int
		Disbursements, Legs   int
		CachePointsAtBatch    bool
		Cache                 int64
		PayloadKeys           []string
		PayloadGross, PayloadNet float64
	}
	read := func(merchantID uuid.UUID) outcome {
		var o outcome
		var batchID uuid.UUID
		if err := pool.QueryRow(ctx, `
			SELECT id, status, gross_fils, fee_fils, net_payout_fils, closed_at IS NOT NULL, paid_at IS NOT NULL
			  FROM settlement_batches WHERE merchant_id = $1 AND batch_date = $2`, merchantID, day).
			Scan(&batchID, &o.Status, &o.Gross, &o.Fee, &o.Net, &o.HasClosedAt, &o.HasPaid); err != nil {
			t.Fatalf("read batch: %v", err)
		}
		o.ClosedEvents = countRows(t, pool, `SELECT count(*) FROM outbox_events WHERE event_type = 'settlement.batch_closed' AND aggregate_id = $1`, batchID)
		o.PaidEvents = countRows(t, pool, `SELECT count(*) FROM outbox_events WHERE event_type = 'settlement.paid' AND aggregate_id = $1`, batchID)
		o.Disbursements = countRows(t, pool, `SELECT count(*) FROM settlement_payout_disbursements WHERE settlement_batch_id = $1`, batchID)
		o.Legs = countRows(t, pool, `SELECT count(*) FROM ledger_entries WHERE settlement_batch_id = $1`, batchID)
		if err := pool.QueryRow(ctx, `SELECT last_settlement_batch_id = $2, cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`,
			merchantID, batchID).Scan(&o.CachePointsAtBatch, &o.Cache); err != nil {
			t.Fatalf("read balance cache: %v", err)
		}
		var raw []byte
		if err := pool.QueryRow(ctx, `SELECT payload FROM outbox_events WHERE event_type = 'settlement.batch_closed' AND aggregate_id = $1`, batchID).Scan(&raw); err != nil {
			t.Fatalf("read batch_closed payload: %v", err)
		}
		var payload map[string]any
		if err := json.Unmarshal(raw, &payload); err != nil {
			t.Fatalf("decode payload: %v", err)
		}
		for k := range payload {
			o.PayloadKeys = append(o.PayloadKeys, k)
		}
		sortStrings(o.PayloadKeys)
		if payload["merchantId"] != merchantID.String() || payload["batchId"] != batchID.String() || payload["batchDate"] != "2025-11-10" {
			t.Fatalf("payload identifies the wrong batch: %v", payload)
		}
		o.PayloadGross, _ = payload["grossFils"].(float64)
		o.PayloadNet, _ = payload["netPayoutFils"].(float64)
		return o
	}

	want, got := read(viaCloseBatch), read(viaDailyRun)
	wantJSON, _ := json.Marshal(want)
	gotJSON, _ := json.Marshal(got)
	if string(wantJSON) != string(gotJSON) {
		t.Fatalf("idle batch differs from the per-merchant path:\n per-merchant: %s\n daily run:    %s", wantJSON, gotJSON)
	}
}

// N+1: CloseBatch wrote one scheme_export_lines row and one residue pair
// per transaction, each its own round trip.
func TestCloseBatch_SchemeLinesAreWrittenSetBased(t *testing.T) {
	plain := mustPool(t)
	pool, counter := countingPool(t)
	ctx := context.Background()
	day := time.Date(2025, 11, 11, 0, 0, 0, 0, time.UTC)
	merchantID := insertActiveMerchant(t, plain, 250)
	withResidue := 0
	for i := 0; i < 200; i++ {
		amount := money.Fils(1000 + i*37)
		if amount%10 != 0 {
			withResidue++
		}
		insertCaptureEvent(t, plain, merchantID, 250, amount, time.Date(2025, 11, 11, 6+i%12, i%60, 0, 0, time.UTC))
	}

	counter.n.Store(0)
	result, err := CloseBatch(ctx, pool, merchantID, day)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if got := counter.n.Load(); got > 40 {
		t.Fatalf("CloseBatch sent %d statements for 200 lines: lines and residue legs must be written set-based", got)
	}
	if n := countRows(t, plain, `SELECT count(*) FROM scheme_export_lines WHERE settlement_batch_id = $1`, result.BatchID); n != 200 {
		t.Fatalf("scheme lines = %d, want 200", n)
	}
	if n := countRows(t, plain, `SELECT count(*) FROM ledger_entries WHERE settlement_batch_id = $1 AND description = 'scheme rounding residue'`, result.BatchID); n != 2*withResidue {
		t.Fatalf("residue legs = %d, want %d (a balanced pair per line with residue)", n, 2*withResidue)
	}
	var seqOK bool
	if err := plain.QueryRow(ctx, `SELECT array_agg(line_sequence ORDER BY line_sequence) = array(SELECT generate_series(1, 200))
	   FROM scheme_export_lines WHERE settlement_batch_id = $1`, result.BatchID).Scan(&seqOK); err != nil || !seqOK {
		t.Fatalf("line_sequence must run 1..200 (err %v)", err)
	}
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}
