#!/bin/sh
# NIGHTGATE container watchdog. Docker marks the container unhealthy but never
# restarts it (`restart: unless-stopped` acts on exits only), so cron runs this
# every minute. After 3 consecutive unhealthy checks:
#
#   stage 1  readiness reports the crawler down and the rest fine (database,
#            runtime, initialization; `node` goes stale with the crawler and is
#            not read): cycle the crawler in place, pauseCrawler + resumeCrawler
#            through the operator API. A halted crawler is a crawler problem;
#            the sponsor facades in the same process take ten minutes and more
#            to warm and must not die for it.
#   stage 2  still unhealthy 3 checks after the cycle (or any other check
#            failing): docker restart -t 5. A hung main thread ignores SIGTERM,
#            so the 90 s grace gains nothing.
#
# `starting` and `healthy` reset the counter. A restart is skipped while the
# host itself is stalled (host-guard.sh, optional: exit 1 = stalled).
#
#   cp docker/watchdog.sh /root/nightgate-api/watchdog.sh
#   crontab -l | { cat; echo '* * * * * /root/nightgate-api/watchdog.sh'; } | crontab -
#
# The container defaults to the compose file's `odatano-nightgate`; a
# different name goes in the cron line: `NIGHTGATE_CONTAINER=<name> /root/...`.

C=${NIGHTGATE_CONTAINER:-odatano-nightgate}
STATE=/run/nightgate-watchdog.count
CYCLED=/run/nightgate-watchdog.cycled          # epoch seconds of the last crawler cycle
LOG=${NIGHTGATE_WATCHDOG_LOG:-/root/nightgate-api/watchdog.log}
GUARD=${NIGHTGATE_HOST_GUARD:-/root/host-guard.sh}
CYCLE_GRACE=${NIGHTGATE_WATCHDOG_CYCLE_GRACE:-900}   # seconds a cycle counts as tried

now() { date -u +%FT%TZ; }

# Indexer service from inside the container: node is there, the operator
# password too, and 127.0.0.1:<PORT> needs no published port. Prints
# "<status> <body>"; status 0 = no answer.
api() {
    docker exec "$C" node -e '
const [method, path] = process.argv.slice(1);
const user = process.env.NIGHTGATE_HTTP_USER || "nightgate";
const auth = "Basic " + Buffer.from(user + ":" + (process.env.NIGHTGATE_HTTP_PASSWORD || "")).toString("base64");
const port = process.env.PORT || "4004";
fetch("http://127.0.0.1:" + port + path, {
    method,
    headers: { accept: "application/json", authorization: auth, "content-type": "application/json" },
    body: method === "POST" ? "{}" : undefined,
    signal: AbortSignal.timeout(20000)
}).then(async r => { console.log(r.status + " " + (await r.text()).replace(/\s+/g, " ").slice(0, 400)); })
  .catch(e => { console.log("0 " + ((e && e.message) || e)); });
' "$1" "$2" 2>/dev/null
}

# Readiness says: crawler down, database / runtime / initialization up.
only_crawler_down() {
    r=$(api GET "/api/v1/indexer/getReadiness()")
    body=${r#* }
    case "$body" in
        *'"crawler":false'*) ;;
        *) return 1 ;;
    esac
    case "$body" in
        *'"database":false'*|*'"runtime":false'*|*'"initialization":false'*) return 1 ;;
    esac
    return 0
}

cycle_crawler() {
    p=$(api POST "/api/v1/indexer/pauseCrawler")
    sleep 3
    r=$(api POST "/api/v1/indexer/resumeCrawler")
    echo "$(now) crawler cycle: pause -> $p | resume -> $r" >> "$LOG"
    case "$r" in
        200*) return 0 ;;
        *) return 1 ;;
    esac
}

if ! st=$(docker inspect -f '{{.State.Health.Status}}' "$C" 2>/dev/null); then
    echo "$(now) container $C not found; set NIGHTGATE_CONTAINER" >> "$LOG"
    logger -t nightgate-watchdog "container $C not found; set NIGHTGATE_CONTAINER"
    exit 0
fi
n=$(cat "$STATE" 2>/dev/null || echo 0)
if [ "$st" != unhealthy ]; then
    [ "$n" != 0 ] && echo 0 > "$STATE"
    exit 0
fi

n=$((n + 1)); echo "$n" > "$STATE"
[ "$n" -ge 3 ] || exit 0

cycled_at=$(cat "$CYCLED" 2>/dev/null || echo 0)
age=$(( $(date +%s) - cycled_at ))
if [ "$age" -gt "$CYCLE_GRACE" ] && only_crawler_down; then
    echo "$(now) unhealthy for $n checks, only the crawler is down: cycling it in place" >> "$LOG"
    logger -t nightgate-watchdog "unhealthy for $n checks, cycling the crawler of $C"
    date +%s > "$CYCLED"
    if cycle_crawler; then
        echo 0 > "$STATE"
        exit 0
    fi
    echo "$(now) crawler cycle failed; falling through to the restart" >> "$LOG"
fi

if [ -x "$GUARD" ] && ! msg=$("$GUARD"); then
    echo "$(now) unhealthy for $n checks, restart skipped: $msg" >> "$LOG"
    exit 0
fi

echo "$(now) unhealthy for $n checks, docker restart -t 5 $C" >> "$LOG"
logger -t nightgate-watchdog "unhealthy for $n checks, restarting $C"
docker restart -t 5 "$C" >> "$LOG" 2>&1
echo 0 > "$STATE"
rm -f "$CYCLED"
exit 0
