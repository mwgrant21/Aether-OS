package transcript

import "testing"

func fp(f float64) *float64 { return &f }

func TestComputeSeverity(t *testing.T) {
	cases := []struct {
		name       string
		exit       ExitState
		elapsed    int64
		median     *float64
		wantSev    int
		wantMedian *float64
	}{
		{"ok, no median", ExitOK, 99999, nil, 1, nil},
		{"ok, slow over median", ExitOK, 3001, fp(1000), 2, fp(1000)},
		{"ok, exactly 3x is not slow", ExitOK, 3000, fp(1000), 1, fp(1000)},
		{"ok, zero median ignored", ExitOK, 99999, fp(0), 1, nil},
		{"ok, negative median ignored", ExitOK, 99999, fp(-5), 1, nil},
		{"partial", ExitPartial, 0, nil, 2, nil},
		{"timeout", ExitTimeout, 0, nil, 3, nil},
		{"error", ExitError, 0, nil, 4, nil},
		{"error, slow", ExitError, 9000, fp(1000), 4, fp(1000)},
		{"fatal", ExitFatal, 0, nil, 4, nil},
		{"blocked", ExitBlocked, 0, nil, 4, nil},
		{"killed", ExitKilled, 0, nil, 2, nil},
		{"killed, slow", ExitKilled, 9000, fp(1000), 2, fp(1000)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			sev, med := ComputeSeverity(c.exit, c.elapsed, c.median)
			if sev != c.wantSev {
				t.Fatalf("severity = %d, want %d", sev, c.wantSev)
			}
			if (med == nil) != (c.wantMedian == nil) || (med != nil && *med != *c.wantMedian) {
				t.Fatalf("median = %v, want %v", med, c.wantMedian)
			}
		})
	}
}

func TestExitStateForStatus(t *testing.T) {
	for status, want := range map[DispatchStatus]ExitState{
		StatusFailed: ExitError, StatusKilled: ExitKilled, StatusCompleted: ExitOK, StatusUnknown: ExitOK,
	} {
		if got := ExitStateForStatus(status); got != want {
			t.Fatalf("ExitStateForStatus(%q) = %q, want %q", status, got, want)
		}
	}
}

func TestMedianOf(t *testing.T) {
	seq := func(n int) []int64 {
		out := make([]int64, n)
		for i := range out {
			out[i] = int64(i + 1)
		}
		return out
	}
	// 25 samples 1..25: only the last 20 (6..25) count, median (15+16)/2.
	cases := []struct {
		name string
		in   []int64
		want *float64
	}{
		{"four samples is not enough", []int64{1, 2, 3, 4}, nil},
		{"five samples take the middle", []int64{5, 1, 4, 2, 3}, fp(3)},
		{"six samples average the middle two", seq(6), fp(3.5)},
		{"only the last 20 count", seq(25), fp(15.5)},
		{"zeros and negatives are filtered", []int64{0, -1, 1, 2, 3, 4, 5}, fp(3)},
		{"filtering can drop below the minimum", []int64{0, 0, 1, 2, 3, 4}, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := MedianOf(c.in)
			if (got == nil) != (c.want == nil) || (got != nil && *got != *c.want) {
				t.Fatalf("MedianOf = %v, want %v", got, c.want)
			}
		})
	}
}
