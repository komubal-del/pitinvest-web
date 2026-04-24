# 봇 업그레이드 Phase 2: 매도조건 자동화

`main.py`에 아래 모듈 2개를 추가해서 **매도 3조건 전부 자동** 판정.

## 📦 설치 필요 패키지

```bash
pip install youtube-transcript-api requests
```

`requirements.txt`에 추가:
```
requests
beautifulsoup4
yfinance
pytz
youtube-transcript-api
```

---

# 모듈 1 · 이론 평단 자동 계산

실제 평단(`exit_settings.json`)이 **있으면 그걸 사용**, **없으면(=0) 시뮬레이션**.

```python
# ============================================================
# 이론 평단 계산 (사이클 시작점부터 매수 이벤트 시뮬레이션)
# ============================================================
import csv
import yfinance as yf

def parse_ratio(raw):
    """00:50:50 → [0, 50, 50] (현금, 코어, 위성)"""
    if not raw or not isinstance(raw, str):
        return [0, 0, 0]
    parts = [int(p) if p.isdigit() else 0 for p in raw.split(':')]
    while len(parts) < 3:
        parts.append(0)
    return parts[:3]


def load_history_rows(csv_path='pitinvest_history.csv'):
    rows = []
    try:
        with open(csv_path, encoding='utf-8') as f:
            reader = csv.DictReader(f)
            rows = list(reader)
    except FileNotFoundError:
        pass
    return rows


def count_buy_signals(row):
    """한 행에서 매수 조건 충족 개수 (CSV 구조에 따라 조정)"""
    count = 0
    cnn = row.get('cnn', '') or row.get('CNN', '')
    vix = row.get('vix', '') or row.get('VIX', '')
    news = row.get('news', '') or row.get('margin_call', '')
    for v in [cnn, vix, news]:
        if str(v).strip().upper() == 'O':
            count += 1
    return count


def find_cycle_start(rows):
    """사이클 시작점 = 가장 최근 위성 비중 0%였던 날"""
    for row in reversed(rows):
        ratio_raw = row.get('ratio_raw') or row.get('ratio', '100:0:0')
        if parse_ratio(ratio_raw)[2] == 0:
            return row.get('date') or row.get('Date')
    return rows[0].get('date') if rows else None


def fetch_close_price(ticker, date_str):
    """특정 날짜의 종가. date_str은 YYYY-MM-DD 또는 MM.DD 등 다양한 포맷 대응."""
    try:
        # YYYY-MM-DD로 정규화 시도
        if '.' in date_str and len(date_str) <= 6:
            # "04.15" 형식 → 올해로 가정
            from datetime import datetime
            y = datetime.now().year
            m, d = date_str.split('.')
            target = f"{y}-{m.zfill(2)}-{d.zfill(2)}"
        else:
            target = date_str

        t = yf.Ticker(ticker)
        hist = t.history(start=target, period='5d')
        if not hist.empty:
            return float(hist['Close'].iloc[0])
    except Exception as e:
        print(f"[price] {ticker} {date_str} fail: {e}")
    return None


def compute_theoretical_avg(rows, ticker):
    """사이클 시작점부터 매수 이벤트 시뮬레이션 → 가중평균 평단"""
    if not rows:
        return None
    start = find_cycle_start(rows)
    if not start:
        return None

    # 시작일 이후 매수 이벤트 추출
    events = []
    passed_start = False
    for row in rows:
        date = row.get('date') or row.get('Date')
        if date == start:
            passed_start = True
            continue
        if not passed_start:
            continue
        count = count_buy_signals(row)
        if count == 0:
            continue
        # 1~2개 충족 = 20%p (1회성), 3개 = 매일 5%p
        amount = 5 if count >= 3 else 20
        events.append({'date': date, 'amount': amount})

    # 100% 상한 적용 (규칙 B)
    cum = 0
    capped = []
    for e in events:
        if cum >= 100:
            break
        take = min(e['amount'], 100 - cum)
        capped.append({**e, 'amount': take})
        cum += take

    # 가격 fetch 및 가중 평균
    total_cost, total_wt = 0.0, 0.0
    for e in capped:
        price = fetch_close_price(ticker, e['date'])
        if price is None:
            continue
        total_cost += price * e['amount']
        total_wt  += e['amount']

    return round(total_cost / total_wt, 2) if total_wt > 0 else None


def compute_leverage_profit_v2(exit_settings, history_rows):
    """
    실제 평단 있으면 그대로 사용, 없으면 이론 평단 시뮬레이션.
    반환: 각 종목별 {actual, theoretical, used, profit_pct, source}
    """
    result = {}
    tickers = {
        'tqqq': ('TQQQ', exit_settings.get('tqqq_avg', 0)),
        'soxl': ('SOXL', exit_settings.get('soxl_avg', 0)),
        'koru': ('KORU', exit_settings.get('koru_avg', 0)),
    }
    for key, (ticker, actual) in tickers.items():
        theoretical = compute_theoretical_avg(history_rows, ticker)
        
        # 사용 평단 결정
        if actual and actual > 0:
            used, source = actual, 'actual'
        elif theoretical:
            used, source = theoretical, 'theoretical'
        else:
            used, source = None, 'none'

        # 현재가 fetch해서 수익률 계산
        profit = None
        if used:
            try:
                h = yf.Ticker(ticker).history(period='5d')
                if not h.empty:
                    current = float(h['Close'].iloc[-1])
                    profit = round((current / used - 1) * 100, 2)
            except Exception:
                pass

        result[f'{key}_profit_pct'] = profit
        result[f'{key}_avg_used']     = used
        result[f'{key}_avg_actual']   = actual if actual and actual > 0 else None
        result[f'{key}_avg_theoretical'] = theoretical
        result[f'{key}_avg_source']   = source

    return result
```

---

# 모듈 2 · 유튜브 전문가 경고 분석 (RSS + 키워드)

```python
# ============================================================
# 삼프로TV 박병창·윤지호 영상 분석
# ============================================================
import requests
import xml.etree.ElementTree as ET
from youtube_transcript_api import YouTubeTranscriptApi

CHANNEL_ID_SAMPRO = 'UChlv4GSd7OQl3js-jkLOnFA'  # 삼프로TV_경제의신과함께
TARGET_EXPERTS = ['박병창', '윤지호']

WARNING_KEYWORDS = [
    '조정', '하락', '리스크', '경계', '위험',
    '고점', '피크', '과열', '버블', '꼭지',
    '비중 축소', '매도', '손절', '경고',
    '현금 비중', '디레버리지', '위험 신호', '주의',
]

BULLISH_KEYWORDS = [
    '낙관', '상승', '매수 기회', '저점', '반등', '회복',
    '기회', '강세', '추가 매수',
]


def fetch_channel_rss(channel_id=CHANNEL_ID_SAMPRO):
    """채널 RSS 피드 → 최근 15개 영상 (XML)"""
    url = f'https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}'
    res = requests.get(url, timeout=10)
    res.raise_for_status()
    return ET.fromstring(res.content)


def parse_rss(root):
    """RSS 파싱 → [{video_id, title, published, link}, ...]"""
    ns = {
        'atom': 'http://www.w3.org/2005/Atom',
        'yt':   'http://www.youtube.com/xml/schemas/2015',
    }
    out = []
    for entry in root.findall('atom:entry', ns):
        vid = entry.find('yt:videoId', ns)
        title = entry.find('atom:title', ns)
        pub   = entry.find('atom:published', ns)
        if vid is None or title is None:
            continue
        out.append({
            'video_id':  vid.text,
            'title':     title.text,
            'published': pub.text if pub is not None else '',
            'url':       f'https://youtube.com/watch?v={vid.text}',
        })
    return out


def filter_expert_videos(videos, experts=TARGET_EXPERTS):
    return [v for v in videos if any(e in v['title'] for e in experts)]


def get_transcript_safe(video_id):
    """자막 추출. 실패하면 None."""
    try:
        tr = YouTubeTranscriptApi.get_transcript(video_id, languages=['ko'])
        return ' '.join([t['text'] for t in tr])
    except Exception:
        return None


def analyze_keywords(text):
    """경고 키워드 vs 낙관 키워드 카운트 → net score"""
    if not text:
        return None
    w = sum(1 for kw in WARNING_KEYWORDS if kw in text)
    b = sum(1 for kw in BULLISH_KEYWORDS if kw in text)
    return {'warning': w, 'bullish': b, 'net': w - b}


def check_expert_warnings():
    """
    삼프로TV에서 박병창·윤지호 최근 영상 분석.
    반환: {expert_warning: bool, videos: [...], summary}
    """
    try:
        root = fetch_channel_rss()
        videos = parse_rss(root)
    except Exception as e:
        print(f"[RSS] fail: {e}")
        return {'expert_warning': False, 'videos': [], 'error': str(e)}

    expert_videos = filter_expert_videos(videos)[:5]  # 최근 5개
    results = []
    for v in expert_videos:
        transcript = get_transcript_safe(v['video_id'])
        # 자막 우선, 없으면 제목 fallback (방식 C)
        source_text = transcript or v['title']
        source_name = 'transcript' if transcript else 'title'

        ana = analyze_keywords(source_text)
        results.append({
            **v,
            'analyzed_source': source_name,
            'analysis': ana,
        })

    # 하나라도 net >= 3이면 경고
    is_warning = any(
        r['analysis'] and r['analysis']['net'] >= 3
        for r in results
    )
    top_url = next((r['url'] for r in results if r['analysis'] and r['analysis']['net'] >= 3), None)

    return {
        'expert_warning': is_warning,
        'expert_count':   len(expert_videos),
        'videos':         results,
        'top_warning_url': top_url,
    }
```

---

# 통합: `build_snapshot` 확장

기존 `build_snapshot()` 에서 `leverage_profit` + `sell_signals` 부분을 아래로 교체:

```python
def build_snapshot(market_data, exit_settings, cnn_value, signals_count):
    KST = pytz.timezone("Asia/Seoul")
    now = datetime.datetime.now(KST).isoformat()

    ext = fetch_extended_market()

    # === 자동화된 매도 신호 ===
    history_rows = load_history_rows('pitinvest_history.csv')
    leverage = compute_leverage_profit_v2(exit_settings, history_rows)

    leading = check_leading_stock_rising("SMH", 3)  # 기존 함수

    expert = check_expert_warnings()

    snapshot = {
        "timestamp": now,
        "sentiment": {
            "cnn_fng": cnn_value,
            "cnn_components": fetch_cnn_components(),
            "put_call_ratio": None,
            "aaii_bull_bear_spread": None,
        },
        "volatility": ext["volatility"],
        "korea_flow": {
            "foreign_inst_buy_krw": market_data.get("foreign_inst_buy_krw"),
            "retail_net_buy_krw":   market_data.get("retail_net_buy_krw"),
            "margin_loan_krw":      None,
            "short_sale_balance":   None,
            "foreign_ownership_pct": None,
        },
        "indices":   ext["indices"],
        "sector_rs": ext["sector_rs"],

        # ---- 매수 ----
        "signals": {
            "cnn_under_10":         (cnn_value is not None and cnn_value < 10),
            "vix_over_25":          (ext["volatility"].get("vix", 0) > 25),
            "margin_call_trigger":  market_data.get("margin_call_triggered", False),
            "count":                signals_count,
            "emergency_exit_warning": any(
                (v.get("drop_pct", 0) or 0) <= -9.0
                for v in ext["indices"].values()
            ),
        },

        # ---- 매도 (자동화) ----
        "leverage_profit": leverage,
        "sell_signals": {
            "leading_stock_rising_3d": leading,
            "expert_warning":          expert["expert_warning"],
            "expert_top_url":          expert.get("top_warning_url"),
            "expert_videos_analyzed":  len(expert.get("videos", [])),
        },
        "expert_analysis": expert,  # 전체 영상 목록 + 키워드 점수

        "recommended_action": market_data.get("recommended_action", "평시 유지"),
    }
    return snapshot
```

---

# ⚠️ CSV 컬럼 확인

`pitinvest_history.csv`의 실제 컬럼명을 먼저 확인하세요:

```bash
head -1 pitinvest_history.csv
```

필요 컬럼:
- `date` (YYYY-MM-DD 권장)
- `cnn`, `vix`, `news` (O/X) — **또는** 수치값
- `ratio_raw` (00:50:50)

컬럼명이 다르면 `count_buy_signals()` 와 `find_cycle_start()` 내부 키 조정.

---

# 🧪 로컬 테스트

```python
# test_automation.py
from main import compute_leverage_profit_v2, check_expert_warnings, load_history_rows
import json

rows = load_history_rows()
exit_cfg = json.load(open('exit_settings.json'))

print("=== 평단가 ===")
print(compute_leverage_profit_v2(exit_cfg, rows))

print("\n=== 전문가 경고 ===")
result = check_expert_warnings()
print(f"경고: {result['expert_warning']}")
print(f"분석 영상: {result['expert_count']}개")
for v in result['videos']:
    ana = v.get('analysis', {})
    print(f"  - [{v['published'][:10]}] {v['title'][:40]} | w:{ana.get('warning')} b:{ana.get('bullish')} net:{ana.get('net')}")
```

---

# 🎯 Phase 3 (나중) — Gemini LLM 업그레이드

키워드 한계가 느껴지면 Gemini로 업그레이드:

```python
import google.generativeai as genai

genai.configure(api_key=os.environ['GEMINI_API_KEY'])
model = genai.GenerativeModel('gemini-1.5-flash')

def analyze_with_gemini(transcript, expert_name):
    prompt = f"""
다음은 한국 주식 전문가 {expert_name}의 최신 영상 자막이다.

[자막]
{transcript[:8000]}

이 영상에서 전문가가 현재 시장에 대해:
(1) 명확한 매도·비중축소 경고를 하고 있는가?
(2) 단순 리스크 언급인가?
(3) 낙관적·중립적 톤인가?

답: (1) / (2) / (3) 중 하나로만, 번호만 응답.
"""
    response = model.generate_content(prompt)
    return response.text.strip()
```

→ 키워드 net >= 3 이면 Gemini에 2차 검증 (API 호출 최소화)
