"""종목 목록과 종가를 수집해 Supabase에 저장하는 배치.

GitHub Actions가 하루 두 번 실행 (국내장 마감 후, 미국장 마감 후).
표준 라이브러리만 사용.

  환경변수: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
  python batch/update_prices.py              # 종목 목록 + 종가
  python batch/update_prices.py --no-symbols # 종가만
  python batch/update_prices.py --dry-run --symbols 005930,KR:035720,US:AAPL
                                             # DB 없이 수집만 해보고 출력
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

UA = "Mozilla/5.0 (compatible; gongsi-batch/1.0)"
KST = timezone(timedelta(hours=9))


def http_get(url: str, retries: int = 3) -> bytes:
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except (urllib.error.URLError, TimeoutError) as e:
            if isinstance(e, urllib.error.HTTPError) and e.code == 404:
                raise
            if i == retries - 1:
                raise
            time.sleep(2 * (i + 1))
    raise RuntimeError("unreachable")


# ── 종목 목록 ───────────────────────────────────────────

KR_SUFFIX = {"유가": ".KS", "코스닥": ".KQ", "코넥스": ".KN"}
KR_EXCHANGE = {"유가": "KOSPI", "코스닥": "KOSDAQ", "코넥스": "KONEX"}


def fetch_kr_stocks() -> list[dict]:
    """한국거래소 KIND 상장법인 목록 (주식만, ETF 제외)."""
    raw = http_get("https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&searchType=13")
    text = raw.decode("euc-kr", errors="replace")
    rows = []
    for tr in re.findall(r"<tr>(.*?)</tr>", text, re.S):
        tds = [html.unescape(re.sub(r"<[^>]+>", "", td)).strip() for td in re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)]
        if len(tds) < 3:
            continue
        name, market, code = tds[0], tds[1], tds[2]
        if market not in KR_SUFFIX or not re.fullmatch(r"[0-9A-Z]{6}", code):
            continue
        rows.append({"market": "KR", "symbol": code, "name": name,
                     "exchange": KR_EXCHANGE[market], "yahoo": code + KR_SUFFIX[market]})
    return rows


def fetch_kr_etfs() -> list[dict]:
    """국내 ETF 목록 (네이버 금융)."""
    raw = http_get("https://finance.naver.com/api/sise/etfItemList.nhn")
    try:
        data = json.loads(raw.decode("utf-8"))
    except UnicodeDecodeError:
        data = json.loads(raw.decode("euc-kr"))
    return [{"market": "KR", "symbol": it["itemcode"], "name": it["itemname"],
             "exchange": "ETF", "yahoo": it["itemcode"] + ".KS"}
            for it in data["result"]["etfItemList"]]


US_EXCHANGE = {"A": "NYSE American", "N": "NYSE", "P": "NYSE Arca", "Z": "Cboe", "V": "IEX"}


def clean_us_name(name: str) -> str:
    name = re.sub(r"\s+-\s+(Common Stock|Class [A-Z] Common Stock|Ordinary Shares).*$", "", name)
    name = re.sub(r"\s+(Common Stock|Common Shares)\s*$", "", name)
    return name.strip()[:80]


def fetch_us() -> list[dict]:
    """미국 상장 종목 (나스닥 트레이더 공식 목록, ETF 포함)."""
    rows = []
    base = "https://www.nasdaqtrader.com/dynamic/SymDir/"
    for line in http_get(base + "nasdaqlisted.txt").decode("utf-8", "replace").splitlines()[1:]:
        f = line.split("|")
        if len(f) < 8 or f[3] != "N":
            continue
        rows.append((f[0], f[1], "NASDAQ"))
    for line in http_get(base + "otherlisted.txt").decode("utf-8", "replace").splitlines()[1:]:
        f = line.split("|")
        if len(f) < 8 or f[6] != "N":
            continue
        rows.append((f[0], f[1], US_EXCHANGE.get(f[2], f[2])))
    out = []
    for sym, name, ex in rows:
        if not re.fullmatch(r"[A-Z][A-Z0-9.]{0,9}", sym):  # 우선주($)·워런트 표기 등 제외
            continue
        out.append({"market": "US", "symbol": sym, "name": clean_us_name(name) or sym,
                    "exchange": ex, "yahoo": sym.replace(".", "-")})
    return out


# ── 종가 ────────────────────────────────────────────────

# 장 마감 + 여유 시간 (현지 시각). 이 전이면 오늘 봉은 아직 확정 아님.
FINAL_AFTER = {"Asia/Seoul": (16, 0), "America/New_York": (16, 30)}


def fetch_closes(yahoo: str) -> list[tuple[str, float]]:
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(yahoo)}?range=1mo&interval=1d"
    try:
        data = json.loads(http_get(url))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return []
        raise
    res = (data.get("chart") or {}).get("result")
    if not res:
        return []
    r = res[0]
    meta = r["meta"]
    offset = timedelta(seconds=meta.get("gmtoffset", 0))
    tzname = meta.get("exchangeTimezoneName", "")
    now_local = datetime.now(timezone.utc) + offset
    cutoff = FINAL_AFTER.get(tzname, (23, 59))
    today_final = (now_local.hour, now_local.minute) >= cutoff and now_local.weekday() < 5
    closes = (r.get("indicators", {}).get("quote") or [{}])[0].get("close") or []
    out = []
    for ts, c in zip(r.get("timestamp") or [], closes):
        if c is None:
            continue
        d = (datetime.fromtimestamp(ts, timezone.utc) + offset).date()
        if d == now_local.date() and not today_final:
            continue
        out.append((d.isoformat(), round(float(c), 4)))
    return out


# ── Supabase (PostgREST) ────────────────────────────────

class DB:
    def __init__(self, url: str, key: str):
        self.base = url.rstrip("/") + "/rest/v1/"
        self.h = {"apikey": key, "Content-Type": "application/json"}
        if key.startswith("eyJ"):  # 옛 형식(JWT) service_role 키. 새 형식 sb_secret_ 키는 apikey 헤더만 씀
            self.h["Authorization"] = "Bearer " + key

    def _req(self, method: str, path: str, body=None, extra=None):
        req = urllib.request.Request(self.base + path, method=method,
                                     data=None if body is None else json.dumps(body).encode(),
                                     headers={**self.h, **(extra or {})})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"{method} {path} -> {e.code} {e.read().decode('utf-8', 'replace')[:300]}")

    def select_all(self, path: str, page: int = 1000) -> list[dict]:
        out, start = [], 0
        while True:
            rows = self._req("GET", path, extra={"Range": f"{start}-{start + page - 1}"})
            out += rows
            if len(rows) < page:
                return out
            start += page

    def upsert(self, table: str, rows: list[dict], chunk: int = 1000):
        for i in range(0, len(rows), chunk):
            self._req("POST", table, rows[i:i + chunk],
                      {"Prefer": "resolution=merge-duplicates,return=minimal"})


def guess_yahoo(market: str, symbol: str) -> list[str]:
    if market == "KR":
        return [symbol + ".KS", symbol + ".KQ"]
    return [symbol.replace(".", "-")]


def parse_symbol_args(s: str) -> list[tuple[str, str]]:
    out = []
    for tok in filter(None, (t.strip() for t in s.split(","))):
        if ":" in tok:
            m, sym = tok.split(":", 1)
        else:
            m, sym = ("KR" if re.fullmatch(r"[0-9A-Z]{6}", tok) and tok[0].isdigit() else "US"), tok
        out.append((m.upper(), sym.upper()))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-symbols", action="store_true", help="종목 목록 갱신 생략")
    ap.add_argument("--dry-run", action="store_true", help="DB에 쓰지 않고 출력만")
    ap.add_argument("--symbols", default="", help="dry-run 때 조회할 종목 (예: 005930,US:AAPL)")
    args = ap.parse_args()

    db = None
    if not args.dry_run:
        # 붙여넣을 때 딸려 온 공백·줄바꿈 제거
        url = (os.environ.get("SUPABASE_URL") or "").strip()
        key = (os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
        if not url or not key:
            sys.exit("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.")
        db = DB(url, key)

    # 1) 종목 목록
    yahoo_map: dict[tuple[str, str], str] = {}
    if not args.no_symbols:
        all_syms: dict[tuple[str, str], dict] = {}
        for name, fn in [("국내 주식", fetch_kr_stocks), ("국내 ETF", fetch_kr_etfs), ("미국", fetch_us)]:
            try:
                rows = fn()
                print(f"[종목] {name}: {len(rows):,}개")
                for r in rows:
                    all_syms[(r["market"], r["symbol"])] = r
            except Exception as e:  # 한 소스가 죽어도 나머지는 진행
                print(f"[종목] {name} 실패: {e}")
        today = datetime.now(KST).date().isoformat()
        rows = [{**r, "updated": today} for r in all_syms.values()]
        yahoo_map = {k: v["yahoo"] for k, v in all_syms.items()}
        if db and rows:
            db.upsert("symbols", rows)
            print(f"[종목] 저장 {len(rows):,}개")

    # 2) 공시된 종목
    if args.dry_run:
        targets = parse_symbol_args(args.symbols) or [("KR", "005930"), ("US", "AAPL")]
    else:
        posted = db.select_all("posts?select=market,symbol&order=id")
        targets = sorted({(p["market"], p["symbol"]) for p in posted})
        if not yahoo_map and targets:
            for p in db.select_all("symbols?select=market,symbol,yahoo&symbol=in.(" +
                                   ",".join(urllib.parse.quote(f'"{s}"') for _, s in targets) + ")"):
                yahoo_map[(p["market"], p["symbol"])] = p["yahoo"]
    print(f"[종가] 대상 {len(targets)}개 종목")

    # 3) 종가 수집
    out, failed = [], []
    for market, sym in targets:
        cands = [yahoo_map[(market, sym)]] if (market, sym) in yahoo_map else guess_yahoo(market, sym)
        bars = []
        for y in cands:
            try:
                bars = fetch_closes(y)
            except Exception as e:
                print(f"  {market}:{sym} ({y}) 오류: {e}")
            if bars:
                break
        if not bars:
            failed.append(f"{market}:{sym}")
            continue
        last_d, last_c = bars[-1]
        print(f"  {market}:{sym} -> {len(bars)}일치, 최근 {last_d} 종가 {last_c:,}")
        out += [{"market": market, "symbol": sym, "trade_date": d, "close": c} for d, c in bars]
        time.sleep(0.3)  # 시세 서버에 부담 주지 않게

    if db and out:
        db.upsert("closes", out)
    print(f"[종가] 저장 {len(out):,}행" + (" (dry-run, 저장 안 함)" if args.dry_run else ""))
    if failed:
        print("[종가] 시세 못 찾음: " + ", ".join(failed))


if __name__ == "__main__":
    main()
