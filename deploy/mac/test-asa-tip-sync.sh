#!/bin/bash
# Scenario test for asa-tip-sync.py against two scratch repos: "mac" plays the tip host, "box" the follower.
set -u
D=$(cd "$(dirname "$0")" && pwd)
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT; cd "$W"
export ASA_SYNC_REPO=$W/box ASA_SYNC_URL=$W/mac ASA_SYNC_LOG=$W/sync.log ASA_SYNC_CARRY=$W/carried ASA_SYNC_BLOCK_STATE=$W/blocked.json ASA_SYNC_BLOCK_ALERT_S=0 ASA_SYNC_PRIME_BIN=$W/fake-prime ASA_SYNC_STATE=$W ASA_SYNC_TRANSCRIPTS=$W/prime ASA_SYNC_BOARD_APPLY=$W/fake-board
G="git -c user.email=t@t -c user.name=t"
fail=0
run() { /usr/bin/python3 -B "$D/asa-tip-sync.py" | tail -1; }
expect() { if tail -1 "$W/sync.log" | grep -q "$1"; then echo "PASS $2"; else echo "FAIL $2: $(tail -1 "$W/sync.log")"; fail=1; fi; }
printf '#!/bin/sh\necho "$2 $3" >> "$(dirname "$0")/sent.txt"\n' > "$W/fake-prime"; chmod +x "$W/fake-prime"
printf '#!/bin/sh\necho "$@" >> "$(dirname "$0")/board.txt"\necho "added a todo t9 \\"x\\""\n' > "$W/fake-board"; chmod +x "$W/fake-board"
mkdir mac && cd mac && git init -q -b sieun/dev && mkdir -p apps/llm-wiki/content src
echo p1 > apps/llm-wiki/content/page.html; echo c1 > src/code.py; echo x > src/other.py
git add . && $G commit -qm c1 && cd ..
git clone -q -b sieun/dev mac box
mac_commit() { (cd "$W/mac" && printf "$2" > "$1" && git add "$1" && $G commit -qm "$3"); }

mac_commit src/code.py 'c2\n' c2; run >/dev/null; expect '"fast-forward"' "1 clean fast-forward"
run >/dev/null; expect '"noop"' "2 nothing new"
echo live > "$W/box/src/code.py"; mac_commit src/code.py 'c3\n' c3; run >/dev/null; expect '"overlap": \["src/code.py"\]' "3 live edit that overlaps the range rides on the move, keeping the live side (box stuck 06:36Z to 08:3xZ on 10-18)"
[ "$(cat "$W/box/src/code.py")" = live ] && [ "$(cd "$W/box" && git rev-parse HEAD)" = "$(cd "$W/mac" && git rev-parse HEAD)" ] && ls "$W"/carried/*/src/code.py >/dev/null && echo "PASS 3b box at the tip, live line kept, old bytes saved" || { echo "FAIL 3b"; fail=1; }
(cd "$W/box" && git checkout -q -- src/code.py)
printf 'u\n' > "$W/box/src/added.py"; mac_commit src/added.py 'a\n' added; run >/dev/null; expect '"kept_local": \["src/added.py"\]' "3c an untracked file the range adds keeps its bytes and does not hold the move"
(cd "$W/box" && git checkout -q -- src/added.py)
touch "$W/box/.git/index.lock"; mac_commit src/code.py 'c3b\n' c3b; run >/dev/null; expect 'index.lock exists' "3d a fresh index.lock holds the move"
touch -d '5 minutes ago' "$W/box/.git/index.lock"; run >/dev/null; expect '"fast-forward"' "3e an index.lock older than STALE_LOCK_S with no holder is removed and the move goes on (box stuck behind one on 10-18)"
[ ! -e "$W/box/.git/index.lock" ] && echo "PASS 3f stale lock gone" || { echo "FAIL 3f"; fail=1; }
echo live > "$W/box/src/other.py"; mac_commit src/code.py 'c3c\n' c3c; run >/dev/null; expect '"fast-forward"' "4 live edit on a path the range does not write"
[ "$(cat "$W/box/src/other.py")" = live ] && echo "PASS 4b live edit kept" || { echo "FAIL 4b"; fail=1; }
printf 'p1\np2 box\n' > "$W/box/apps/llm-wiki/content/page.html"; mac_commit apps/llm-wiki/content/page.html 'p1\np2\n' p2
run >/dev/null; expect '"kept_local": \["apps/llm-wiki/content/page.html"\]' "5 wiki page edited on the box keeps its bytes"
[ "$(tail -1 "$W/box/apps/llm-wiki/content/page.html")" = "p2 box" ] && echo "PASS 5b box bytes kept" || { echo "FAIL 5b"; fail=1; }
printf 'new\n' > "$W/box/apps/llm-wiki/content/new.html"; mac_commit apps/llm-wiki/content/new.html 'new\n' p3
run >/dev/null; expect '"preapplied": 1' "6 untracked file equal to the tip"
(cd "$W/box" && echo s > src/staged.py && git add src/staged.py); mac_commit src/code.py 'c4\n' c4
S=01a14dfb-a0b6-776e-a08f-1a87496f2061; mkdir -p "$W/prime/sessions"
printf '{"timestamp":"%s","message":{"role":"assistant","content":[{"type":"toolCall","name":"ipython","arguments":{"code":"open(\\"src/staged.py\\",\\"w\\").write(\\"s\\")"}}]}}\n' "$(date -u -d '-1 sec' +%Y-%m-%dT%H:%M:%S.000Z)" > "$W/prime/sessions/$S.jsonl"
ASA_SYNC_FORYOU_S=0 run >/dev/null; expect 'stages changes' "7 staged index skips"
grep -q "^$S .*your session last wrote src/staged.py" "$W/sent.txt" && echo "PASS 7e the session that wrote the blocking path is told (ecosystem.config.cjs held the box 08:25Z to 08:34Z on 10-18 and only the ops chat heard)" || { echo "FAIL 7e"; fail=1; }
grep -q 'todo_add.*Session 01a14dfb wrote src/staged.py and was told' "$W/board.txt" && echo "PASS 7f past FORYOU_S one line goes on the chat's For you list" || { echo "FAIL 7f"; fail=1; }
ASA_SYNC_FORYOU_S=0 run >/dev/null; [ "$(grep -c "^$S " "$W/sent.txt")" = 1 ] && [ "$(grep -c todo_add "$W/board.txt")" = 1 ] && [ -e "$W/box/src/staged.py" ] && echo "PASS 7g told once, asked once, the edit stays" || { echo "FAIL 7g"; fail=1; }
(cd "$W/box" && git rm -q --cached src/staged.py && rm src/staged.py)
(cd "$W/mac" && printf 'top\nmid\nend\n' > src/carry.py && git add src/carry.py && $G commit -qm carry0); run >/dev/null
printf 'top\nmid\nend\nlive\n' > "$W/box/src/carry.py"; (cd "$W/mac" && printf 'TOP\nmid\nend\n' > src/carry.py && git add src/carry.py && $G commit -qm carry1)
run >/dev/null; expect '"carried": \["src/carry.py"\]' "7a live edit that merges cleanly rides on the move"
grep -q '"todo_update", "id": "t9", "done": true' "$W/board.txt" && echo "PASS 7h the For you line is checked off once the box follows again" || { echo "FAIL 7h"; fail=1; }
[ "$(cat "$W/box/src/carry.py" | tr '\n' ' ')" = "TOP mid end live " ] && ls "$W"/carried/*/src/carry.py >/dev/null && echo "PASS 7a2 merged bytes on disk, old bytes saved" || { echo "FAIL 7a2"; fail=1; }
(cd "$W/box" && git checkout -q -- src/carry.py)
echo draft > "$W/box/src/draft.py"; touch -d '2 hours ago' "$W/box/src/draft.py"; mac_commit src/draft.py 'final\n' landed-draft
run >/dev/null; expect '"superseded": \["src/draft.py"\]' "7d a draft older than the commit that changed its path takes the tip's bytes"
[ "$(cat "$W/box/src/draft.py")" = final ] && ls "$W"/carried/*/src/draft.py >/dev/null && echo "PASS 7d2 draft saved, tip bytes on disk" || { echo "FAIL 7d2"; fail=1; }
mac_commit src/code.py 'c4b\n' c4b; (cd "$W/box" && git update-index --cacheinfo "100644,$(cd "$W/mac" && git rev-parse HEAD:src/code.py),src/code.py")
run >/dev/null; expect '"fast-forward"' "7b a path staged at the tip's bytes does not hold the move"
[ "$(cat "$W/box/src/code.py")" = c4b ] && [ -z "$(cd "$W/box" && git status --porcelain -- src/code.py)" ] && echo "PASS 7c its file gets the tip's bytes" || { echo "FAIL 7c"; fail=1; }
(cd "$W/box" && echo b > src/boxonly.py && git add src/boxonly.py && $G commit -qm box)
run >/dev/null; expect 'commits the tip lacks' "8 box commit the Mac lacks skips"
B=$(cd "$W/box" && git rev-parse HEAD)
(cd "$W/mac" && echo b > src/boxonly.py && git add src/boxonly.py && $G commit -qm "box

Replayed-From: $B")
mac_commit src/code.py 'c5\n' c5
run >/dev/null; expect '"converge"' "9 box commit replayed on the Mac: the box follows the Mac tip"
H=$(cd "$W/box" && git rev-parse HEAD); M=$(cd "$W/mac" && git rev-parse HEAD)
[ "$H" = "$M" ] && [ "$(cat "$W/box/src/code.py")" = c5 ] && echo "PASS 9b box HEAD and tree equal the Mac tip" || { echo "FAIL 9b $H $M"; fail=1; }
(cd "$W/box" && echo d > src/d.py && git add src/d.py && $G commit -qm d)
(cd "$W/mac" && echo d > src/d.py && git add src/d.py && $G commit -qm "d, same bytes, no trailer")
run >/dev/null; expect '"converge"' "10 same bytes on the Mac without a trailer converge"
run >/dev/null; expect '"noop"' "11 nothing new after converge"
grep -q "has not followed the tip host" "$W/sent.txt" && grep -q "follows the tip host again" "$W/sent.txt" && echo "PASS 12 a block alerts the ops chat once and the recovery says so" || { echo "FAIL 12"; fail=1; }
[ "$(grep -c "^01a11af8.* has not followed" "$W/sent.txt")" -le 3 ] && echo "PASS 12b one alert per block" || { echo "FAIL 12b $(grep -c "^01a11af8.* has not followed" "$W/sent.txt")"; fail=1; }
(cd "$W/mac" && printf 'v1\n' > src/stale.py && git add src/stale.py && $G commit -qm stale0); run >/dev/null
(cd "$W/mac" && printf 'v2\n' > src/stale.py && printf 'n1\n' > src/landed.py && git add src/stale.py src/landed.py && $G commit -qm land1)
(cd "$W/box" && git fetch -q "$W/mac" sieun/dev && git update-ref refs/heads/sieun/dev FETCH_HEAD && printf 'never committed\n' > src/other.py)
mac_commit src/stale.py 'v3\n' land2
run >/dev/null; expect '"stale_index_count": 2' "13 a land that moved sieun/dev without the index leaves staged entries that no longer hold the move (Mac 86 staged paths, 10-18 11:35Z)"
expect '"stale": \["src/stale.py", "src/landed.py"\]' "13b files on disk at a state the branch moved past take the tip's bytes"
[ "$(cat "$W/box/src/stale.py")" = v3 ] && [ "$(cat "$W/box/src/landed.py")" = n1 ] && [ "$(cat "$W/box/src/other.py")" = "never committed" ] && [ "$(cat "$W"/carried/*/src/stale.py)" = v1 ] \
  && [ -z "$(cd "$W/box" && git status --porcelain -- src/stale.py src/landed.py)" ] && echo "PASS 13c tip bytes on disk, old bytes saved, the never-committed edit stays" || { echo "FAIL 13c $(tail -1 "$W/sync.log")"; fail=1; }
(cd "$W/box" && printf 'p\n' > src/pid.py && git add src/pid.py && $G commit -qm pid)
(cd "$W/mac" && printf 'p\n' > src/pid.py && git add src/pid.py && $G commit -qm "pid on the tip host" && printf 'q\n' > src/pid.py && git add src/pid.py && $G commit -qm "pid again")
run >/dev/null; expect '"converge"' "14 a local commit whose change the tip holds as the same patch converges after the tip changed that path again (6a73f04e21, 10-18 11:49Z)"
mkdir -p "$W/mac/src/gone" && (cd "$W/mac" && printf 'g\n' > src/gone/rule.yaml && git add src/gone/rule.yaml && $G commit -qm gone0); run >/dev/null
printf 'live rule\n' > "$W/box/src/gone/rule.yaml"; (cd "$W/mac" && git rm -q src/gone/rule.yaml && $G commit -qm "gone1")
run >/dev/null; expect '"fast-forward"' "15 a live edit on a file the tip deletes does not hold the move (crawler-proxy-success-prod.yaml, 10-18 12:22Z)"
[ "$(cat "$W/box/src/gone/rule.yaml")" = "live rule" ] && [ "$(cd "$W/box" && git status --porcelain -- src/gone)" = "?? src/gone/" ] && echo "PASS 15b the edit stays as an untracked file" || { echo "FAIL 15b $(cd "$W/box" && git status --porcelain -- src/gone)"; fail=1; }
mkdir -p "$W/mac/apps/virev-demo"
(cd "$W/mac" && printf 'base\n' > apps/virev-demo/app.css && printf 'v1\n' > apps/virev-demo/old.svelte && printf 'a\nb\nc\n' > src/ci.py \
  && git add apps/virev-demo src/ci.py && $G commit -qm demo0 && printf 'v2\n' > apps/virev-demo/old.svelte && git add apps/virev-demo && $G commit -qm demo1 \
  && git checkout -qb ci/demo-blue-sparingly && printf 'blue sparingly\n' > apps/virev-demo/app.css && printf 'a\nb\nc\nci\n' > src/ci.py \
  && git add apps/virev-demo src/ci.py && $G commit -qm blue && git checkout -q sieun/dev); run >/dev/null
(cd "$W/box" && git fetch -q "$W/mac" ci/demo-blue-sparingly:refs/remotes/origin/ci/demo-blue-sparingly \
  && git show origin/ci/demo-blue-sparingly:apps/virev-demo/app.css > apps/virev-demo/app.css && git show origin/ci/demo-blue-sparingly:src/ci.py > src/ci.py \
  && printf 'v1\n' > apps/virev-demo/old.svelte && touch -d '2 hours ago' apps/virev-demo/app.css apps/virev-demo/old.svelte)
(cd "$W/mac" && printf 'base\ntip\n' > apps/virev-demo/app.css && printf 'A\nb\nc\n' > src/ci.py && git add apps/virev-demo src/ci.py && $G commit -qm demo2)
run >/dev/null; expect '"carried": \["src/ci.py"\]' "16 bytes that only a ci/ branch holds are a live edit that rides on the move (205 demo edits on origin/ci/demo-blue-sparingly dropped at 12:28Z on 10-18)"
expect '"kept_local": \["apps/virev-demo/app.css"\]' "16b a demo file the tip changes keeps its bytes"
[ "$(cat "$W/box/apps/virev-demo/app.css")" = "blue sparingly" ] && [ "$(cat "$W/box/apps/virev-demo/old.svelte")" = v1 ] && [ "$(cat "$W/box/src/ci.py" | tr '\n' ' ')" = "A b c ci " ] \
  && echo "PASS 16c both demo files keep their bytes, also one at an older tip state, and the ci/ edit merges onto the tip" || { echo "FAIL 16c $(tail -1 "$W/sync.log")"; fail=1; }
exit $fail
