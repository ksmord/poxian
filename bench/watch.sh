#!/system/bin/sh
# 轮询 bench 进度，直到 jsonl 行数到目标或日志出现 DONE
TARGET="$1"; LOG="$2"; JSONL="$3"
i=0
while [ $i -lt 600 ]; do
  n=$(wc -l < "$JSONL" 2>/dev/null || echo 0)
  if grep -q '^DONE' "$LOG" 2>/dev/null; then
    echo "FINISHED lines=$n"; exit 0
  fi
  if [ "$n" -ge "$TARGET" ]; then
    echo "REACHED lines=$n"; exit 0
  fi
  sleep 5
  i=$((i+1))
done
echo "TIMEOUT lines=$(wc -l < $JSONL 2>/dev/null || echo 0)"