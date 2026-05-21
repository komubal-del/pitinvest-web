# 봇 패치: 긴급탈출 200일선 트렌드 필터 (v5.2)

웹은 이미 v5.2(200일선 트렌드 필터)로 업데이트됨. **봇이 아래 두 가지를 `current_snapshot.json`에 채워야** 홈 대시보드 "긴급탈출 트렌드 필터" 카드가 실데이터로 동작하고, 실제 긴급탈출 판정도 새 룰로 바뀐다.

## 왜 바꾸나 (요약)

- **기존**: 나스닥/S&P/코스피 중 하나라도 52주 신고가 대비 **−10%** → 긴급탈출.
- **문제**: 코스피 단독 일시적 급락(미국 정상)에 오발동. 2026-05 코스피 −10%→다음날 +8% V반등 사건에서 바닥 청산 손실.
- **신규**: 나스닥/S&P/코스피 중 하나라도 **종가가 200일 이동평균을 −2% 하회(2거래일 연속)** → 긴급탈출. 200일선 위로 회복하면 재진입.
- **근거**: Kaminski & Lo(2014, 손절은 추세적 하락에서만 가치) · Faber(2007, 200일선 트렌드 필터) · LETF+200일선 연구. 56년 백테스트에서 −10% 룰(CAGR 15.6%/MDD −64%) 대비 200일선+2%(CAGR 30.4%/Sharpe 0.82/MDD −56%)가 전부 우위.

---

## 1) 지수 루프에 200일선(sma_200) 추가

`fetch_extended_market()`의 지수 수집 루프(`for key, ticker in idx_tickers.items()`)를 아래로 교체:

```python
    for key, ticker in idx_tickers.items():
        try:
            t = yf.Ticker(ticker)
            hist = t.history(period="1y")
            if not hist.empty:
                closes   = hist["Close"]
                current  = float(closes.iloc[-1])
                high_52w = float(hist["High"].max())
                drop_pct = (current / high_52w - 1) * 100

                # --- v5.2: 200일 단순이동평균 + 200일선 하회 연속일수 ---
                sma_200 = None
                below_streak = 0
                if len(closes) >= 200:
                    sma_series = closes.rolling(window=200).mean()
                    sma_200 = float(sma_series.iloc[-1])
                    # 종가가 200일선 -2% 아래로 내려간 연속 거래일 수 (최근부터 역순)
                    buffer = 0.98  # -2% 버퍼
                    for i in range(len(closes) - 1, -1, -1):
                        s = sma_series.iloc[i]
                        if s == s and closes.iloc[i] < s * buffer:  # s==s: NaN 아님
                            below_streak += 1
                        else:
                            break

                result["indices"][key] = {
                    "current":  round(current, 2),
                    "high_52w": round(high_52w, 2),
                    "drop_pct": round(drop_pct, 2),
                    "sma_200":  round(sma_200, 2) if sma_200 is not None else None,
                    "below_sma200_streak": below_streak,
                }
        except Exception as e:
            print(f"[idx] {key} fail: {e}")
```

`current_snapshot.json`의 각 지수가 이렇게 나온다:

```json
"nasdaq": { "current": 26270.36, "high_52w": 26707.14, "drop_pct": -1.64, "sma_200": 23034.0, "below_sma200_streak": 0 }
```

## 2) 긴급탈출 트리거 로직 교체

`signals.emergency_exit_warning`(및 stage 판정)을 트렌드 필터로 교체.

```python
    TREND_INDICES = ("nasdaq", "kospi", "sp500")  # 트리거 대상 3개 지수
    SMA_BUFFER_PCT = 2.0    # 200일선 -2% 하회 시 발동
    CONFIRM_DAYS   = 2      # 2거래일 연속 확인 (장중 휩쏘 방지)

    def _below_trend(v):
        sma = v.get("sma_200")
        cur = v.get("current")
        if sma is None or cur is None:
            return False
        return cur < sma * (1 - SMA_BUFFER_PCT / 100)

    # 발동: 3개 지수 중 하나라도 200일선 -2% 하회가 2거래일 연속
    emergency_fired = any(
        (ext["indices"].get(k, {}).get("below_sma200_streak", 0) >= CONFIRM_DAYS)
        for k in TREND_INDICES
    )
    # 임박(경고): 하나라도 지금 200일선 -2% 아래(연속일수 미달 포함)
    emergency_warning = any(
        _below_trend(ext["indices"].get(k, {})) for k in TREND_INDICES
    )
```

그리고 `signals` 블록:

```python
        "signals": {
            "cnn_under_10":         (cnn_value is not None and cnn_value < 10),
            "vix_over_25":          (ext["volatility"].get("vix", 0) > 25),
            "margin_call_trigger":  market_data.get("margin_call_triggered", False),
            "count":                signals_count,
            "emergency_exit_warning": emergency_warning,   # 200일선 트렌드 필터 기준
            "emergency_exit_fired":   emergency_fired,      # 2일 연속 확정 발동
        },
```

## 3) stage_key 판정

봇이 `display stage_key`를 계산하는 곳에서, 긴급탈출 우선순위를 트렌드 필터로:

```python
    if emergency_fired:
        stage_key = "emergency"   # 위성 전량 청산 → 코어 균등 매수
    # ... 이후 기존 매수/매도 카운터 기반 stage 판정 ...
```

**재진입**: `emergency_fired`가 False로 풀리면(3개 지수 모두 200일선 위 회복) 위성 재매수 사이클 재개. 별도 플래그가 필요하면 `signals.emergency_exit_fired`의 직전 True→False 전이를 재진입 시점으로 사용.

---

## 검증 체크리스트
- [ ] `current_snapshot.json` 각 지수에 `sma_200`, `below_sma200_streak` 존재
- [ ] 홈 대시보드 "긴급탈출 트렌드 필터" 카드가 "데이터 대기" 대신 각 지수 200일선 대비 % 표시
- [ ] 평시: "✅ 안전 (전 지수 200일선 위)" / 발동 시: "🚨 긴급탈출 발동"
- [ ] 코스피만 단독 급락(미국 200일선 위) 시 **미발동** 확인 (휩쏘 회피)
