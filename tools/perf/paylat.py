# Per-endpoint latency from the API's pino JSON logs (request + response lines
# joined on reqId). Prints p50/p95/max per route and status, for groups of 20+.
# Usage: docker compose -f ops/docker-compose.yml logs --no-log-prefix api | python3 tools/perf/paylat.py
import sys, json, collections
urls = {}; out = collections.defaultdict(list)
for line in sys.stdin:
    try: j = json.loads(line[line.index('{'):])
    except Exception: continue
    rid = j.get('reqId')
    if 'req' in j and 'url' in j['req']:
        u = j['req']['url']; m = j['req'].get('method','')
        urls[rid] = m + ' ' + ('pay' if u.endswith('/pay') else 'get-link' if '/payment-links/' in u else u.split('?')[0])
    elif 'res' in j and 'responseTime' in j:
        out[(urls.get(rid,'?'), j['res'].get('statusCode'))].append(j['responseTime'])
def pct(a,p): a=sorted(a); return a[min(len(a)-1,int(p*len(a)))]
for k,v in sorted(out.items(), key=lambda kv:-len(kv[1])):
    if len(v) < 20: continue
    print(f"{k[0]:<28} {k[1]}  n={len(v):5}  p50={pct(v,.5):7.0f}ms  p95={pct(v,.95):7.0f}ms  max={max(v):7.0f}ms")
