# 히스토리 Backfill: 1년치 데이터 한방에 채우기

기존 `pitinvest_history.csv`는 **덮어쓰기**하고 통일된 스키마로 재생성.

---

## 📊 새 CSV 스키마

```csv
date,cnn_fng,vix,vvix,skew,nasdaq_close,nasdaq_52w_high,nasdaq_drop_pct,kospi_close,kospi_52w_high,kospi_drop_pct,sp500_close,sp500_drop_pct,russell2k_close,russell2k_drop_pct,soxx_close,soxx_drop_pct,tqqq_close,soxl_close,koru_close,smh_close,cnn_trigger,vix_trigger,margin_trigger,signal_count,ratio_cash,ratio_core,ratio_sat,memo
```

**의미**:
- `date` — YYYY-MM-DD
- `cnn_fng` — CNN Fear & Greed (0~100)
- `*_close` — 종가
- `*_52w_high`, `*_drop_pct` — 52주 신고가 & 낙폭
- `*_trigger` — 조건 충족 여부 (1/0)
- `signal_count` — 조건 충족 개수 (0~3)
- `ratio_*` — 포지션 비중 (백필시 빈값, 봇이 매일 채움)
- `memo` — 사용자 메모

---

## 🧱 백필 스크립트 (`backfill_history.py`)

별도 파일로 리포 루트에 생성. **1회만 실행**하면 됨.

```python
"""
pitinvest_history.csv 재생성 — 최근 1년 데이터 백필

실행: python backfill_history.py
"""
import yfinance as yf
import pandas as pd
import requests
from datetime import datetime


TICKERS = {
    'nasdaq':    '^IXIC',
    'kospi':     '^KS11',
    'sp500':     '^GSPC',
    'russell2k': '^RUT',
    'soxx':      'SOXX',
    'vix':       '^VIX',
    'vvix':      '^VVIX',
    'skew':      '^SKEW',
    'tqqq':      'TQQQ',
    'soxl':      'SOXL',
    'koru':      'KORU',
    'smh':       'SMH',
}

INDEX_KEYS = ['nasdaq', 'kospi', 'sp500', 'russell2k', 'soxx']  # 52주 낙폭 계산 대상


def fetch_cnn_history():
    """CNN Fear & Greed 과거 값 (약 2년)"""
    url = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata'
    headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        'Accept': 'application/json',
        'Referer': 'https://www.cnn.com/',
    }
    try:
        res = requests.get(url, headers=headers, timeout=15)
        res.raise_for_status()
        data = res.json()
        hist = data.get('fear_and_greed_historical', {}).get('data', [])
        # timestamp(ms) → YYYY-MM-DD
        out = {}
        for item in hist:
            d = datetime.fromtimestamp(item['x'] / 1000).strftime('%Y-%m-%d')
            out[d] = round(float(item['y']), 2)
        return out
    except Exception as e:
        print(f"[CNN] fail: {e}")
        return {}


def fetch_yf_close(ticker, period='1y'):
    """yfinance 종가 dict (date → close)"""
    try:
        h = yf.Ticker(ticker).history(period=period)
        if h.empty:
            return {}
        return {d.strftime('%Y-%m-%d'): round(float(v), 2)
                for d, v in h['Close'].items()}
    except Exception as e:
        print(f"[{ticker}] fail: {e}")
        return {}


def compute_rolling_52w_high(series_dict):
    """date → close 시리즈에서 각 시점까지의 52주 신고가·낙폭 계산"""
    dates = sorted(series_dict.keys())
    highs, drops = {}, {}
    running_max = None
    for d in dates:
        c = series_dict[d]
        if running_max is None or c > running_max:
            running_max = c
        highs[d] = running_max
        drops[d] = round((c / running_max - 1) * 100, 2)
    return highs, drops


def build_history(output_path='pitinvest_history.csv'):
    print("[1/3] yfinance 데이터 수집 중...")
    yf_data = {}
    for name, tkr in TICKERS.items():
        yf_data[name] = fetch_yf_close(tkr, period='1y')
        print(f"  - {name}: {len(yf_data[name])}일")

    print("[2/3] CNN Fear & Greed 히스토리 수집 중...")
    cnn_data = fetch_cnn_history()
    print(f"  - CNN: {len(cnn_data)}일")

    # 52주 고점·낙폭 계산
    highs, drops = {}, {}
    for key in INDEX_KEYS:
        highs[key], drops[key] = compute_rolling_52w_high(yf_data.get(key, {}))

    # 날짜 기준: 나스닥 거래일
    dates = sorted(yf_data.get('nasdaq', {}).keys())
    print(f"[3/3] CSV 생성 중... ({len(dates)}행)")

    rows = []
    for date in dates:
        row = {'date': date}

        # 가격
        for key in TICKERS:
            row[f'{key}_close'] = yf_data.get(key, {}).get(date)

        # 52주 낙폭 (지수만)
        for key in INDEX_KEYS:
            row[f'{key}_52w_high'] = highs[key].get(date)
            row[f'{key}_drop_pct'] = drops[key].get(date)

        # CNN
        row['cnn_fng'] = cnn_data.get(date)

        # 시그널
        cnn_val = row['cnn_fng']
        vix_val = row['vix_close']
        row['cnn_trigger']    = 1 if cnn_val is not None and cnn_val < 10 else 0
        row['vix_trigger']    = 1 if vix_val is not None and vix_val > 25 else 0
        row['margin_trigger'] = 0  # 백필 불가 (국내 수급 히스토리 없음)
        row['signal_count']   = row['cnn_trigger'] + row['vix_trigger'] + row['margin_trigger']

        # 포지션 상태 (백필시 공란, 봇이 오늘부터 채움)
        row['ratio_cash'] = None
        row['ratio_core'] = None
        row['ratio_sat']  = None
        row['memo']       = ''

        rows.append(row)

    # 컬럼 순서 정렬
    cols = (
        ['date', 'cnn_fng']
        + ['vix', 'vvix', 'skew']  # 변동성은 close 형태 아님
        + [f'{k}_close'    for k in INDEX_KEYS]
        + [f'{k}_52w_high' for k in INDEX_KEYS]
        + [f'{k}_drop_pct' for k in INDEX_KEYS]
        + ['tqqq_close', 'soxl_close', 'koru_close', 'smh_close']
        + ['cnn_trigger', 'vix_trigger', 'margin_trigger', 'signal_count']
        + ['ratio_cash', 'ratio_core', 'ratio_sat', 'memo']
    )

    # vix/vvix/skew는 close 형태로 접근했으므로 리네이밍
    for row in rows:
        row['vix']  = row.pop('vix_close',  None)
        row['vvix'] = row.pop('vvix_close', None)
        row['skew'] = row.pop('skew_close', None)

    df = pd.DataFrame(rows)
    df = df[[c for c in cols if c in df.columns]]
    df.to_csv(output_path, index=False)

    print(f"\n✅ [완료] {output_path} 생성 ({len(df)}행, {len(df.columns)}컬럼)")
    print("\n[미리보기: 최근 5일 시그널 발생 여부]")
    recent = df[df['signal_count'] > 0].tail(10)
    if not recent.empty:
        print(recent[['date', 'cnn_fng', 'vix', 'signal_count', 'tqqq_close']].to_string(index=False))
    else:
        print("  최근 1년 중 매수조건 충족일 없음 (평온한 시장)")


if __name__ == '__main__':
    build_history()
```

---

## 🚀 실행

```bash
cd ~/pitinvest-bot
python backfill_history.py
```

**예상 출력**:
```
[1/3] yfinance 데이터 수집 중...
  - nasdaq: 251일
  - kospi: 244일
  ...
[2/3] CNN Fear & Greed 히스토리 수집 중...
  - CNN: 364일
[3/3] CSV 생성 중... (251행)

✅ [완료] pitinvest_history.csv 생성 (251행, 28컬럼)

[미리보기: 최근 5일 시그널 발생 여부]
       date  cnn_fng   vix  signal_count  tqqq_close
 2024-08-05     18.5  38.5            1       55.32
 2024-08-06     22.1  30.2            0       56.10
 ...
```

---

## 🔄 봇 `main.py` 수정 — 매일 이어쓰기

봇이 매일 돌면서 **오늘 행 추가** (백필 덮어쓰기 X).

```python
# main.py 내 save_daily_row 함수 (새로 추가)
import os
import csv as csvmod

def save_daily_row(snapshot, master_data, csv_path='pitinvest_history.csv'):
    """현재 스냅샷을 CSV에 오늘 행으로 이어쓰기"""
    from datetime import datetime
    import pytz
    KST = pytz.timezone("Asia/Seoul")
    today = datetime.now(KST).strftime('%Y-%m-%d')

    # 기존 데이터 로드
    df = pd.read_csv(csv_path) if os.path.exists(csv_path) else pd.DataFrame()

    # 오늘 이미 있으면 갱신
    if not df.empty and today in df['date'].values:
        df = df[df['date'] != today]

    # 새 행 생성 (스냅샷 → CSV 행 매핑)
    idx = snapshot.get('indices', {})
    vol = snapshot.get('volatility', {})
    sig = snapshot.get('signals', {})
    ratio = parse_ratio(master_data.get('ratio_raw', ''))

    new_row = {
        'date': today,
        'cnn_fng': snapshot.get('sentiment', {}).get('cnn_fng'),
        'vix':  vol.get('vix'),
        'vvix': vol.get('vvix'),
        'skew': vol.get('skew'),
    }
    for k in ['nasdaq', 'kospi', 'sp500', 'russell2k', 'soxx']:
        d = idx.get(k, {})
        new_row[f'{k}_close']    = d.get('current')
        new_row[f'{k}_52w_high'] = d.get('high_52w')
        new_row[f'{k}_drop_pct'] = d.get('drop_pct')

    new_row.update({
        'tqqq_close': fetch_close_today('TQQQ'),
        'soxl_close': fetch_close_today('SOXL'),
        'koru_close': fetch_close_today('KORU'),
        'smh_close':  fetch_close_today('SMH'),
        'cnn_trigger':    int(bool(sig.get('cnn_under_10'))),
        'vix_trigger':    int(bool(sig.get('vix_over_25'))),
        'margin_trigger': int(bool(sig.get('margin_call_trigger'))),
        'signal_count':   sig.get('count', 0),
        'ratio_cash': ratio[0],
        'ratio_core': ratio[1],
        'ratio_sat':  ratio[2],
        'memo':       master_data.get('memo', ''),
    })

    df = pd.concat([df, pd.DataFrame([new_row])], ignore_index=True)
    df = df.sort_values('date').reset_index(drop=True)
    df.to_csv(csv_path, index=False)


def fetch_close_today(ticker):
    try:
        h = yf.Ticker(ticker).history(period='5d')
        return round(float(h['Close'].iloc[-1]), 2) if not h.empty else None
    except Exception:
        return None
```

기존 save 로직 대체 (혹은 병행):

```python
# 메인 실행부
save_snapshot(snapshot)                         # current_snapshot.json
save_daily_row(snapshot, master_data)           # pitinvest_history.csv 이어쓰기
```

---

## 📊 효과

### ✅ 이론 평단 즉시 작동
backfill된 1년치 데이터가 있으니 `compute_theoretical_avg()` 바로 가동 가능. 오늘부터 "마지막 위성 0% 날짜"부터 시뮬레이션.

### ✅ 웹의 히스토리 차트 꽉 채움
`history.html`의 시계열 차트가 즉시 1년치로 채워짐. 과거 매수 조건 발생 시점도 보임.

### ✅ 앞으로 매일 자동 누적
봇이 매일 돌며 `save_daily_row` 실행 → CSV에 하루씩 append.

---

## ⚠️ 주의

1. **CNN Historical 엔드포인트는 비공식** — CNN이 구조 바꾸면 수집 실패 (그래도 최근 값은 fetch_market으로 계속 들어옴)
2. **`margin_trigger`는 백필 불가** — 국내 강제청산 히스토리는 무료 소스가 없음. 과거는 0, 오늘부터 수집
3. **kospi 휴일 vs 미국 휴일** — 거래일 안 맞는 날 있을 수 있음. 빈값은 그대로 저장, 웹에서 `-` 표시

---

## 🎯 순서 정리

```
1. backfill_history.py 실행 (1회)
   → pitinvest_history.csv 1년치 생성

2. main.py에 모듈 1 (이론평단) + 모듈 2 (유튜브) 패치
   → bot_patch_automation.md 참고

3. main.py에 save_daily_row 추가
   → 매일 CSV 이어쓰기

4. GitHub push
   → Actions가 매일 자동 실행

5. 웹사이트 자동 반영 ✨
```
