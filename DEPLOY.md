# Deploy Team Battle Game (Netlify + Render hybrid)

멀티플레이는 **항상 Render의 Node + Socket.io** 가 담당합니다.  
Netlify는 **정적 프론트**(`public/`)만 호스팅하고, 브라우저는 Render URL로 소켓/API를 붙입니다.

```
친구들 → https://….netlify.app  (정적 UI)
              │
              └── Socket.io /api/*  →  https://….onrender.com  (게임 서버)
```

같은 레포로 **Render만** 써도 됩니다(Express가 `public/`도 서빙). 하이브리드는 CDN·커스텀 도메인에 Netlify를 쓰고 싶을 때 권장합니다.

---

## 1) Render — 게임 서버 먼저

1. 이 레포를 **GitHub**에 푸시합니다.
2. [https://render.com](https://render.com) → **New → Web Service** (또는 **Blueprint** → `render.yaml`).
3. 설정:
   - **Runtime:** Node
   - **Build:** `npm install`
   - **Start:** `npm start`
   - **Plan:** Free
4. 배포 후 URL 복사: `https://YOUR-APP.onrender.com`  
   (Free는 유휴 후 첫 접속 ~30–60초 웨이크업 가능)

환경 변수(Blueprint에 이미 있음):

| 변수 | 값 | 설명 |
| --- | --- | --- |
| `ENABLE_TUNNEL` | `0` | Render에서 cloudflared 비활성 |
| `NODE_VERSION` | `20` | Node 버전 |
| `PORT` / `HOST` | 호스트가 설정 | `server.js`가 `0.0.0.0` + `PORT` 사용 |

CORS: Socket.io·REST가 Netlify origin을 반영(`origin: true`)합니다.

---

## 2) Netlify — 정적 프론트

1. [https://app.netlify.com](https://app.netlify.com) → **Add new site → Import from Git** → 같은 GitHub 레포.
2. 빌드 설정(`netlify.toml`이 있으면 자동):
   - **Build command:** `node scripts/write-netlify-config.js`
   - **Publish directory:** `public`
3. **Site configuration → Environment variables**에 추가:
   - **Key:** `GAME_SERVER_URL`
   - **Value:** `https://YOUR-APP.onrender.com`  ← Render URL (끝 `/` 없이)
4. Deploy. 사이트 URL 예: `https://….netlify.app`

빌드 스크립트가 `public/config.js`에 `window.GAME_SERVER_URL`을 심습니다.  
`game.js`는 그 값(또는 `localStorage.GAME_SERVER_URL` 오버라이드)으로 `io(SOCKET_URL)` / `fetch(apiUrl(...))` 합니다.

### 로컬에서 Netlify 설정 확인

```bash
set GAME_SERVER_URL=https://YOUR-APP.onrender.com
node scripts/write-netlify-config.js
```

---

## 3) 연결 확인

1. Netlify URL 열기 → 메뉴에 **서버 연결됨 · your-app.onrender.com** 표시.
2. 방 만들기 / 참가 → 멀티플레이 동작.
3. 초대 링크는 **Netlify 페이지 주소**를 보여 줍니다(터널 불필요).

문제 시:

| 증상 | 확인 |
| --- | --- |
| “서버 URL 없음” | Netlify env `GAME_SERVER_URL` 저장 후 **Redeploy** |
| “서버 연결 실패” | Render 서비스 Live인지, URL 오타, Free 웨이크업 |
| 소켓만 안 됨 | 브라우저 콘솔 / Render 로그; CORS는 기본 허용 |

임시 오버라이드(브라우저 콘솔):

```js
localStorage.setItem('GAME_SERVER_URL', 'https://YOUR-APP.onrender.com');
location.reload();
```

---

## Render만 쓰는 경우 (하이브리드 아님)

Web Service 하나로 `npm start` → `https://….onrender.com` 공유.  
`GAME_SERVER_URL` 비우면 same-origin `io()` 동작. `ENABLE_TUNNEL=0` 유지.

---

## 왜 Netlify만으로는 안 되나?

Netlify는 지속 Node 프로세스·Socket.io 룸/틱 루프를 돌리지 않습니다.  
정적 파일 + (선택) 짧은 Functions만 가능 → **게임 서버는 Render(또는 Railway 등)** 가 필요합니다.

| 구성 | 가능? |
| --- | --- |
| Netlify만 | 불가 |
| Render만 | 가능 |
| **Netlify(UI) + Render(소켓)** | **가능 (이 가이드)** |

---

## 로컬 개발

```bash
npm start
```

`config.js`의 `GAME_SERVER_URL`이 비어 있으면 same-origin.  
로컬 공유용 cloudflared는 PaaS가 아닐 때만 자동 시작(Render/Railway/Fly에서는 스킵).
