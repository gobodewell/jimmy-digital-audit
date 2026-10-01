#!/usr/bin/env bash
# Runs every suite. Matches the summary line specifically -- an earlier runner
# grepped for "FAILURE" anywhere, which a test whose HEADING said "records the
# FAILURE" tripped, reporting a green suite as red.
cd "$(dirname "$0")"
pass=0; fail=0; failed=""
for f in test_*.js; do
  out=$(timeout 200 node "$f" 2>&1); code=$?
  if [ $code -eq 0 ] && echo "$out" | grep -qE '^all checks passed$'; then
    pass=$((pass+1)); echo "PASS  $f"
  else
    fail=$((fail+1)); failed="$failed $f"; echo "FAIL  $f"
    echo "$out" | grep -E '^  FAIL|Error' | head -5
  fi
done
echo; echo "passed: $pass   failed: $fail"
[ -n "$failed" ] && echo "failing:$failed"
exit $fail
