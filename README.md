# RIVER

로그인 계정의 개인 머니로 친구들과 6-max 링게임과 9-max 토너먼트를 즐기는 텍사스 홀덤입니다. Cloudflare Worker와 D1이 계정·세션·머니를 저장하고, SQLite Durable Object가 실시간 게임 테이블을 처리합니다.

## 게임 모드

- **6-max 링게임**: 블라인드 100/200, 바이인 10,000칩(50 BB). 입장 시 개인 머니를 차감하고 나가면 남은 칩을 돌려줍니다. 핸드에서 칩을 잃으면 개인 머니를 스택 10,000칩까지 자동 보충하며, 자동 보충과 머니를 사용한 입장·재입장은 바이인 횟수에 포함하지 않습니다. 스택이 5,000칩 이하이면 게임 중 직접 추가 바이인할 수 있으며 횟수는 로비에서만 확인할 수 있습니다.
- **9-max 토너먼트**: 참가 시 10,000칩을 받고, 칩이 0일 때 최대 2회 리엔트리할 수 있습니다. 개인 머니가 10,000 이상이면 항상 먼저 사용하고, 부족할 때 바이인 횟수를 사용합니다. 이미지 기준 블라인드·앤티 34레벨을 기본 6분 또는 터보 3분마다 진행합니다.
- **개인 머니**: 계정 생성 시 10,000으로 시작합니다. 잔액이 5,000 이하이면 링게임 재참가 전에 10,000으로 다시 채울 수 있습니다.
- **로그인**: 비밀번호는 PBKDF2 해시로 저장하고, HttpOnly 세션 쿠키는 최대 400일간 유지·갱신합니다. 결제와 환전은 없습니다.
- **홀덤 엔진**: 폴드, 체크, 콜, 레이즈, 올인, 사이드 팟, 동점 분배, 20초 행동 제한과 상세 핸드 기록을 지원합니다. 링게임과 토너먼트는 준비 입력 없이 온라인 참가자 2명 이상이면 자동 진행합니다.

## 실행

Node.js 22 이상이 필요합니다.

```sh
npm ci
npx wrangler d1 migrations apply hold-em --local
npm run dev
```

`http://localhost:8787`에서 계정을 만들거나 로그인합니다. 토너먼트를 만들고 초대 링크를 공유하거나, 공용 링게임에 입장할 수 있습니다. 배포 주소는 `https://hold-em.jwjoo.com`입니다.

## 확인

```sh
npm run check
npm test
```

로컬 Worker를 실행한 상태에서 HTTP와 WebSocket 흐름을 확인하려면 별도 터미널에서 실행합니다.

```sh
node test/integration.mjs
```

## 배포

Cloudflare Worker와 D1 데이터베이스 이름은 `hold-em`으로 통일했습니다. Worker의 커스텀 도메인은 `hold-em.jwjoo.com`입니다. D1의 `app_state`는 계정, 세션, 머니, 토너먼트 바이인 상태를 저장하고 `PokerRoom` Durable Object는 게임 상태와 실시간 연결을 처리합니다. D1이 비어 있고 같은 Worker의 Durable Object에 이전 `auth-data`가 있으면 처음 읽을 때 복사합니다. 다른 Cloudflare 계정의 기존 데이터는 별도 이동이 필요합니다.

```sh
npx wrangler d1 migrations apply hold-em --remote
npm run deploy
```

## 코드 구성

- `src/game/holdem.js`: 홀덤 규칙과 게임 상태 전이
- `src/game/format.js`: 링게임·토너먼트의 고정 규격과 토너먼트 블라인드 구조
- `src/game/room.js`: 참가, 준비, 링 바이인, 토너먼트 재진입 등 게임 모드 상태
- `src/game/migrations.js`: 저장된 게임 상태의 호환 처리
- `src/game/view.js`: 플레이어별 게임 상태 응답과 비공개 패 필터링
- `src/platform/password.js`, `src/platform/random.js`: 비밀번호와 덱 셔플을 위한 Web Crypto 어댑터
- `src/worker.js`: 인증, 개인 머니, HTTP/WebSocket, Durable Object 연결
- `public/`: 게임 화면과 Worker에서 제공하는 정적 자산
- `test/`: 게임 규칙, 베팅과 API 통합 확인

기존 비공개 캐시 테이블은 새 모드에서 열 수 없습니다. 이전 게임과 기록 데이터는 저장소에 남아 있지만, 회원 명단·주간 랭킹·수동 장부 화면과 API는 제거했습니다. 계정과 링게임·토너먼트 데이터는 유지됩니다.
