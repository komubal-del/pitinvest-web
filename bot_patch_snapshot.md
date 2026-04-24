# 봇 업그레이드: current_snapshot.json 작성 로직

이 패치를 `main.py`에 추가하면 웹페이지가 수치 기반으로 동작해요.

## 📌 추가할 내용

### 1) 모듈 상단 imports (yfinance로 추가 데이터 수집)
이미 있다면 무시:
```python
import json
import datetime
import pytz
import yfinance as yf
```

### 2) 시장 데이터 수집 확장 함수

```python
def fetch_extended_market():
    """Tier 1 + 섹터 지표 수집 → dict 반환"""
    result = {
        "sentiment": {},
        "volatility": {},
        "korea_flow": {},
        "indices": {},
        "sector_rs": {},
    }

    # ---- 변동성 (yfinance 티커 기반) ----
    vol_tickers = {
        "vix":  "^VIX",
        "vvix": "^VVIX",
        "skew": "^SKEW",
        "move": "^MOVE",       # 안 잡히면 삭제
    }
    for key, ticker in vol_tickers.items():
        try:
            t = yf.Ticker(ticker)
            hist = t.history(period="5d")
            if not hist.empty:
                result["volatility"][key] = float(hist["Close"].iloc[-1])
        except Exception as e:
            print(f"[vol] {key} fail: {e}")

    # ---- 지수 (현재가·52주 신고가·낙폭) ----
    idx_tickers = {
        "nasdaq":    "^IXIC",
        "kospi":     "^KS11",
        "sp500":     "^GSPC",
        "russell2k": "^RUT",
        "soxx":      "SOXX",
    }
    for key, ticker in idx_tickers.items():
        try:
            t = yf.Ticker(ticker)
            hist = t.history(period="1y")
            if not hist.empty:
                current  = float(hist["Close"].iloc[-1])
                high_52w = float(hist["High"].max())
                drop_pct = (current / high_52w - 1) * 100
                result["indices"][key] = {
                    "current":  round(current, 2),
                    "high_52w": round(high_52w, 2),
                    "drop_pct": round(drop_pct, 2),
                }
        except Exception as e:
            print(f"[idx] {key} fail: {e}")

    # ---- 섹터 상대강도 (vs SPY 기준 3개월 수익률 비율) ----
    sector_tickers = ["XLK", "SMH", "BOTZ", "ARKK", "XLF", "XLE"]
    try:
        spy = yf.Ticker("SPY").history(period="3mo")
        spy_ret = (spy["Close"].iloc[-1] / spy["Close"].iloc[0]) if not spy.empty else 1.0
        for tkr in sector_tickers:
            try:
                h = yf.Ticker(tkr).history(period="3mo")
                if not h.empty and spy_ret:
                    sec_ret = h["Close"].iloc[-1] / h["Close"].iloc[0]
                    result["sector_rs"][tkr] = round(float(sec_ret / spy_ret), 3)
            except Exception as e:
                print(f"[sector] {tkr} fail: {e}")
    except Exception as e:
        print(f"[sector base] fail: {e}")

    return result


def fetch_cnn_components():
    """
    CNN Fear & Greed의 구성요소 7개. 
    CNN Data Biz API 응답 구조에 따라 조정 필요.
    """
    # TODO: 기존 fetch_market의 CNN 부분을 확장해서 components도 저장
    return {
        "momentum":   None,
        "strength":   None,
        "breadth":    None,
        "put_call":   None,
        "junk_bond":  None,
        "volatility": None,
        "safe_haven": None,
    }


def compute_leverage_profit(exit_settings):
    """TQQQ/SOXL/KORU 현재가 대비 평균단가 수익률(%) 계산"""
    result = {}
    pairs = {
        "tqqq_profit_pct": ("TQQQ", exit_settings.get("tqqq_avg", 0)),
        "soxl_profit_pct": ("SOXL", exit_settings.get("soxl_avg", 0)),
        "koru_profit_pct": ("KORU", exit_settings.get("koru_avg", 0)),
    }
    for key, (ticker, avg) in pairs.items():
        if not avg or avg <= 0:
            result[key] = None
            continue
        try:
            t = yf.Ticker(ticker)
            hist = t.history(period="5d")
            if hist.empty:
                result[key] = None
                continue
            current = float(hist["Close"].iloc[-1])
            result[key] = round((current / avg - 1) * 100, 2)
        except Exception as e:
            print(f"[leverage] {ticker} fail: {e}")
            result[key] = None
    return result


def check_leading_stock_rising(ticker="SMH", days=3):
    """주도주(기본 SMH) 3일 연속 상승 체크"""
    try:
        h = yf.Ticker(ticker).history(period="10d")
        if len(h) < days + 1:
            return None
        closes = h["Close"].tail(days + 1).values
        return all(closes[i + 1] > closes[i] for i in range(days))
    except Exception as e:
        print(f"[leading] fail: {e}")
        return None


def build_snapshot(market_data, exit_settings, cnn_value, signals_count):
    """current_snapshot.json용 통합 dict 생성"""
    KST = pytz.timezone("Asia/Seoul")
    now = datetime.datetime.now(KST).isoformat()

    ext = fetch_extended_market()
    leverage = compute_leverage_profit(exit_settings)
    leading  = check_leading_stock_rising("SMH", 3)

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

        # ---- 매수 신호 ----
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

        # ---- 매도 신호 ----
        "leverage_profit": leverage,
        "sell_signals": {
            "leading_stock_rising_3d": leading,
            "expert_warning": exit_settings.get("expert_sell_view", False),
            "retail_net_buy_positive": (market_data.get("retail_net_buy_krw", 0) or 0) > 0,
        },

        "recommended_action": market_data.get("recommended_action", "평시 유지"),
    }
    return snapshot


def save_snapshot(snapshot):
    with open("current_snapshot.json", "w", encoding="utf-8") as f:
        json.dump(snapshot, f, ensure_ascii=False, indent=2)
```

### 3) main 실행부에 추가

기존 `fetch_market()` 호출 후, 최종 처리 부분에 추가:

```python
# ... 기존 로직 ...

snapshot = build_snapshot(
    market_data=market,         # 기존 fetch_market() 결과 dict
    exit_settings=exit_cfg,     # exit_settings.json 로드 결과 dict
    cnn_value=market["cnn"],    # 기존 수집한 공탐지수
    signals_count=signals_count # 기존 조건 충족 개수
)
save_snapshot(snapshot)
```

### 4) GitHub Actions가 snapshot 파일도 커밋하도록 워크플로우 수정

`.github/workflows/*.yml`에 커밋 단계에서 파일명 추가:

```yaml
- name: Commit data files
  run: |
    git add master_data.json exit_settings.json pitinvest_history.csv current_snapshot.json
    git diff --staged --quiet || git commit -m "Update data [skip ci]"
    git push
```

---

## ⚠️ 주의사항

1. **yfinance 속도 제한** — 지표 여러 개 빨리 호출시 rate limit 가능. 실패해도 계속 돌도록 try/except로 감쌈
2. **CNN 구성요소 API** — CNN의 실제 API 응답 구조에 맞춰 `fetch_cnn_components()` 확장 필요
3. **국내 지표 (신용융자/공매도)** — KRX 스크래핑 필요. 지금은 None으로 둠. 웹은 None이면 `-`로 표시
4. **Put/Call, AAII** — 선택 구현. None이면 웹에서 `-` 표시

## 🧪 로컬 테스트

패치 후 봇 실행:
```bash
python main.py
```

생성된 파일 확인:
```bash
cat current_snapshot.json | head -30
```

JSON이 정상 구조면 OK. 웹에서 새로고침하면 자동 반영.
