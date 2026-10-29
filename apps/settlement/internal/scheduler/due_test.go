package scheduler

// The daily close for a Bahrain business day is due at Bahrain midnight plus
// the run delay (the brief: settlement closes daily at midnight Bahrain
// time, UTC+3). These cases pin exact wall-clock instants on both sides of
// the 00:00-03:00 Bahrain window, where the UTC calendar date is still the
// previous day.

import (
	"testing"
	"time"
)

var bahrain = time.FixedZone("Asia/Bahrain", 3*60*60)

func TestDueBusinessDate(t *testing.T) {
	const delay = 15
	cases := []struct {
		name     string
		nowLocal time.Time // Bahrain wall clock
		wantDue  bool
		wantDate string // business date that should close, YYYY-MM-DD
	}{
		{"00:10 Bahrain: still inside the grace period", time.Date(2026, 10, 29, 0, 10, 0, 0, bahrain), false, ""},
		{"00:20 Bahrain: yesterday's close is due", time.Date(2026, 10, 29, 0, 20, 0, 0, bahrain), true, "2026-10-28"},
		{"02:59 Bahrain: still yesterday's close", time.Date(2026, 10, 29, 2, 59, 0, 0, bahrain), true, "2026-10-28"},
		{"03:30 Bahrain", time.Date(2026, 10, 29, 3, 30, 0, 0, bahrain), true, "2026-10-28"},
		{"23:50 Bahrain", time.Date(2026, 10, 29, 23, 50, 0, 0, bahrain), true, "2026-10-28"},
		{"00:20 Bahrain on New Year's Day", time.Date(2027, 1, 1, 0, 20, 0, 0, bahrain), true, "2026-12-31"},
	}
	for _, c := range cases {
		got, due := dueBusinessDate(c.nowLocal.UTC(), delay)
		if due != c.wantDue {
			t.Errorf("%s: due = %v, want %v", c.name, due, c.wantDue)
			continue
		}
		if due && got.Format("2006-01-02") != c.wantDate {
			t.Errorf("%s: business date = %s, want %s", c.name, got.Format("2006-01-02"), c.wantDate)
		}
	}
}
