# 매매공시방

친구끼리 매매를 "공시"하고 왜삼? / 부럽! / 바보ㅋㅋ 로 반응하는 채팅방.
공시마다 최근 확정 종가 기준으로 손익이 붙는다.

- 화면: `index.html` + `app.js` + `backend.js` + `style.css` (빌드 없음, 정적 파일)
- DB·실시간·익명 로그인: Supabase 무료 플랜 (`supabase/schema.sql`)
- 종목 목록·종가: `batch/update_prices.py`를 GitHub Actions가 평일 하루 2번 실행
  - 국내: 네이버 증권 시가총액 목록(우선주·ETF·ETN 포함) + 한국거래소 KIND(공식 회사명·코넥스) / 미국: 나스닥 트레이더 공식 목록
  - 종가: Yahoo Finance 차트 데이터 (키 없음, 비공식이라 막히면 소스 교체 필요)

## 손익 계산 방식

| 공시 | 계산 | 표시 |
|---|---|---|
| 매수 | (최근 종가 − 매수가) × 수량 | +3.5% +₩47,770 |
| 매도 | 매도가 대비 그 뒤 종가 변화 | 판 뒤 올랐어요 · 놓친 돈 / 판 뒤 내렸어요 · 피한 손실 |

- "최근 종가"는 장 마감이 확정된 가장 최근 거래일 종가 (국내 16:00, 미국 16:30 현지시각 이후 확정)
- 원화·달러는 섞지 않고 종목 통화 그대로 표시
- 새로 공시한 종목은 다음 배치 실행 전까지 "종가 수집 전"으로 보임

## 데모로 먼저 보기

`config.js`가 비어 있으면 데모 모드(가짜 데이터)로 열린다.

```bash
python -m http.server 8765
```

브라우저에서 http://127.0.0.1:8765 접속.

## 실제 운영 설정 (한 번만)

### 1. Supabase

1. https://supabase.com 가입 → New project (지역: Northeast Asia (Seoul))
2. **Authentication → Sign In / Providers → Allow anonymous sign-ins 켜기**
3. **SQL Editor**에 `supabase/schema.sql` 전체를 붙여넣고 Run
   → 맨 아래 결과에 나오는 `invite_code`를 메모 (초대 코드)
4. **Project Settings → API**에서 복사
   - Project URL, `anon` `public` 키 → `config.js`에 넣기
   - `service_role` 키 → 3단계 GitHub Secrets에만 넣기 (**절대 config.js에 넣지 말 것**)

### 2. GitHub 저장소 + 페이지

1. 이 폴더를 GitHub 저장소로 올리기 (공개 저장소면 Pages·Actions 무료)
   - 공개해도 되는 이유: 저장소에는 코드와 anon 키뿐. 매매 기록과 초대 코드는 DB에 있음
2. Settings → Pages → Source: `Deploy from a branch`, Branch: `main` / `(root)`
3. 접속 주소: `https://<아이디>.github.io/<저장소>/#<초대코드>` → 이 링크를 친구들에게 공유

### 3. 종가 배치

1. Settings → Secrets and variables → Actions → New repository secret
   - `SUPABASE_URL` = Project URL
   - `SUPABASE_SERVICE_ROLE_KEY` = service_role 키
2. Actions 탭 → "종가 업데이트" → Run workflow로 첫 실행 (종목 목록 약 1.7만 개 저장)
3. 이후 평일 16:30, 07:00 (KST)에 자동 실행

## 운영 메모

- 초대 링크를 모르는 사람은 접속해도 아무것도 못 본다 (DB 보안 규칙으로 차단)
- 초대 코드를 바꾸려면 SQL Editor에서:
  `update rooms set invite_code = encode(gen_random_bytes(12), 'hex') returning invite_code;`
  (기존 멤버는 계속 입장 가능, 새 사람만 새 링크 필요)
- 사람 식별은 브라우저 단위 익명 계정. 폰을 바꾸거나 브라우저 데이터를 지우면 새 사람으로 들어옴 (닉네임을 같게 쓰면 됨, 예전 글 삭제 권한만 사라짐)
- 자기 글만 삭제할 수 있고 수정은 안 됨
- Supabase 무료 프로젝트는 7일간 활동이 없으면 일시정지되지만, 매일 도는 배치가 막아줌

## 배치 단독 테스트 (DB 없이)

```bash
python batch/update_prices.py --dry-run --symbols 005930,247540,US:AAPL
```
