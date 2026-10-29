package internalapi

// The console's "run batch" (internal API) must refuse a business day that
// hasn't ended, with a clear 409 rather than closing it early.

import (
	"fmt"
	"net/http"
	"testing"
	"time"
)

func TestRunBatchForTodayIsAConflict(t *testing.T) {
	pool := mustPool(t)
	server := newTestServer(t, pool)
	today := time.Now().Add(3 * time.Hour).UTC().Format("2006-01-02") // Bahrain calendar date
	resp := post(t, server, "/internal/run-batch", "Bearer "+testToken, fmt.Sprintf(`{"date":%q}`, today))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Errorf("run-batch for today = %d, want 409", resp.StatusCode)
	}
}
