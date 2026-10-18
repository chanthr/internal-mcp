<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/ko/banner-dark.svg">
    <img alt="Knowledge MCP" src=".github/assets/ko/banner-light.svg" width="100%">
  </picture>
</h1>

<p align="center">
  <a href="LICENSE"><img alt="license: MIT" src=".github/assets/badge-license.svg"></a>
  <a href="#빠른-시작"><img alt="node: 22+" src=".github/assets/badge-node.svg"></a>
  <a href="#클라이언트-연결"><img alt="MCP: HTTP + stdio" src=".github/assets/badge-mcp.svg"></a>
  <a href="#접근-권한"><img alt="auth: Key + OAuth" src=".github/assets/badge-auth.svg"></a>
</p>

<p align="center">
  <b>Claude 같은 MCP 클라이언트를 Google Drive, Slack, GitHub, Railway에 연결합니다.</b><br>
  서버 하나를 직접 운영하고, API 키나 Google 로그인으로 사람마다 필요한 데이터만 열어 줍니다.
</p>

<p align="center">
  <a href="README.md">English</a>&nbsp;&nbsp;|&nbsp;&nbsp;<b>한국어</b>
</p>

<p align="center">
  <a href="#빠른-시작"><b>빠른 시작</b></a>&nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp;
  <a href="#도구">도구</a>&nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp;
  <a href="#설정">설정</a>&nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp;
  <a href="#접근-권한">접근 권한</a>&nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp;
  <a href="#배포">배포</a>
</p>

## 빠른 시작

Docker, Supabase 프로젝트, Google Drive 자격 증명이 필요합니다. 의미 검색까지 쓰려면 Qdrant와 OpenAI API 키도 필요합니다.

| 순⁠서 | 할 일 |
| :---: | --- |
| **1** | Supabase SQL 편집기에서 [`sql/setup.sql`](sql/setup.sql)을 실행합니다. `.env.example`을 `.env`로, `mcp.config.example.json`을 `mcp.config.json`으로 복사해 값을 채웁니다. |
| **2** | `docker compose up -d`로 서버를 띄웁니다. 검색 색인은 `docker compose run --rm reindex`로 한 번 만듭니다. |
| **3** | API 키를 만들고 클라이언트를 `http://localhost:8080/mcp`에 연결합니다. `curl localhost:8080/health`가 `{"ok":true}`를 돌려주면 정상입니다. |

<details>
<summary>단계별 명령</summary>
<br>

```bash
# 1) 파일 받기와 설정
git clone https://github.com/chanthr/internal-mcp.git && cd internal-mcp
cp .env.example .env                        # Supabase, Drive, OpenAI, Qdrant, Slack 등 자격 증명
cp mcp.config.example.json mcp.config.json  # Drive 폴더 ID, 제외 폴더, 로그인 허용 목록
# Supabase SQL 편집기에서 sql/setup.sql 실행. 여러 번 실행해도 안전하므로 업그레이드할 때마다 다시 실행합니다.

# 2) 실행과 색인
docker compose up -d
docker compose run --rm reindex             # 첫 전체 색인. 이후 변경분은 서버가 반영합니다

# 3) 확인
curl http://localhost:8080/health
```

API 키는 Supabase SQL 편집기에서 만듭니다. 원래 키는 `openssl rand -hex 32`로 생성해 사용자에게 한 번만 전달합니다. 이메일이 있는 키는 역할과 범위를 `app_users`에서 가져옵니다.

```sql
insert into public.app_users (email, role) values ('you@acme.com', 'admin')
  on conflict (email) do update set role = excluded.role;
insert into public.mcp_keys (key_hash, org_id, email)
values (encode(sha256(convert_to('PASTE_RAW_KEY', 'UTF8')), 'hex'), 'acme', 'you@acme.com');
```

</details>

<details>
<summary>Docker 없이 소스로 실행</summary>
<br>

Node 22 이상이 필요합니다.

```bash
npm install
cp .env.example .env && cp mcp.config.example.json mcp.config.json
npm run reindex          # 전체 Drive 색인 (-- --dry-run 을 붙이면 청크 수만 셉니다)
npm run dev              # MCP_TRANSPORT 값에 따라 http 또는 stdio
npm run build && npm start
```

</details>

## 동작 방식

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/ko/flow-dark.svg">
    <img alt="동작 방식: 연결하기, 권한 확인, 도구 제공, 읽기" src=".github/assets/ko/flow-light.svg" width="100%">
  </picture>
</p>

<details>
<summary>단계별 자세히 보기</summary>
<br>

| 순⁠서 | 누가 | 하는 일 |
| :---: | --- | --- |
| 1 | 클라이언트 | `Authorization: Bearer <API 키 또는 OAuth 액세스 토큰>`으로 `/mcp`를 호출합니다. |
| 2 | 서버 | `mcp_keys`의 해시로 키를 확인하거나 OAuth 토큰을 검증합니다. 이어서 `app_users`에서 사용자 역할과 범위를 읽습니다. |
| 3 | 서버 | 자격 증명이 설정돼 있고 사용자 역할이 허용하는 도구 묶음만 목록에 올립니다. |
| 4 | 데이터 원본 | Drive, Slack, GitHub, Railway를 읽습니다. Drive 결과는 설정한 폴더 안으로 한정하고 제외 폴더는 뺍니다. Slack 결과는 봇이 들어가 있는 채널로 한정합니다. |

</details>

## 도구

도구 묶음은 자격 증명이 설정돼 있을 때만 나타납니다. 그다음 사용자마다 역할이 허용하는 묶음만 보입니다([접근 권한](#접근-권한) 참고). 모든 도구는 읽기만 합니다.

| 도구 | 하는 일 | 필요한 것 |
| --- | --- | --- |
| `search_drive` | Drive root 아래에서 파일 이름을 검색합니다. `mode: "fullText"`면 본문까지 검색합니다. Drive API를 실시간으로 조회합니다 | Drive 자격 증명 |
| `read_drive_file` | 파일 ID로 한 번에 10개까지 읽습니다. 본문은 `maxChars`(기본 50,000자)에서 자릅니다. 색인된 PDF와 Office 파일은 색인에서 읽습니다 | Drive 자격 증명 |
| `list_drive_folder` | Drive root 아래 폴더 트리를 나열합니다. 깊이 3, 폴더당 200개, 호출당 폴더 방문 120회까지입니다 | Drive 자격 증명 |
| `semantic_search_drive` | 색인된 청크를 벡터로 검색합니다. 기본 상위 5개, 최대 20개입니다 | Qdrant, OpenAI, 색인 |
| `slack_list_channels` | `slack_channels` 테이블의 채널 용도 목록을 돌려줍니다. 호출할 때 Slack과 동기화합니다 | 봇 토큰 |
| `slack_read_channel` | 봇이 들어가 있는 채널의 최근 메시지와 스레드 답글을 읽습니다 | 봇 토큰 |
| `slack_find_files` / `slack_get_file` | 봇 채널에 공유된 파일을 찾고, 텍스트 파일은 본문을 돌려줍니다 | 봇 토큰 (키워드 검색은 사용자 토큰 추가) |
| `slack_search` | 메시지를 검색합니다. 결과는 봇이 들어가 있는 채널로 한정합니다 | 사용자 토큰과 봇 토큰 |
| `repo_tree` | GitHub 토큰으로 읽을 수 있는 저장소의 파일 트리를 돌려줍니다 | GitHub 토큰 |
| `github_*` | GitHub 원격 MCP 서버의 읽기 도구를 중계합니다. 무언가를 바꾸는 도구는 숨기고 호출도 거부합니다 | GitHub 토큰 |
| `railway_services` / `railway_deployments` / `railway_logs` | 프로젝트, 배포, 로그를 조회합니다. 로그 속 비밀 값은 가립니다 | Railway 토큰 |
| `ping` | 상태 확인. 어떤 계정으로 로그인했는지도 보여 줍니다 | 없음 |

## 설정

설정은 의도적으로 두 곳에 나눠 둡니다.

| 구분 | 위치 | 내용 |
| --- | --- | --- |
| 비밀 값 | 환경 변수 (로컬은 `.env`, 운영은 호스트 환경 변수) | 키와 토큰. 코드가 읽는 모든 변수와 기본값은 [`.env.example`](.env.example)에 있습니다 |
| 조회 대상 | `mcp.config.json` | Drive 폴더, 제외 폴더, Qdrant 컬렉션, Supabase 스키마, 로그인 허용 목록. [`mcp.config.example.json`](mcp.config.example.json)을 참고합니다 |

설정은 다음 순서로 먼저 찾은 것을 사용합니다. `MCP_CONFIG_JSON`(JSON 문자열), `MCP_CONFIG_PATH`(파일 경로), `./mcp.config.json`, 내장 기본값 순서입니다. 설정이 없으면 Drive root와 로그인 허용 목록이 없는 상태로 뜨고, 부팅 로그에 이를 알립니다.

| 설정 항목 | 뜻 |
| --- | --- |
| `orgId` | 인증 정보에 함께 담기는 조직 식별자 |
| `branding.name` / `branding.instructions` | 서버 이름, 그리고 연결할 때 클라이언트에 전달하는 도구 사용 안내 |
| `drive.roots[]` | 색인하고 검색할 `{ id, name, source }` 폴더. `source`는 `dev`(frontmatter가 있는 Markdown) 또는 `biz`(PDF, Office, Google 파일) |
| `drive.excludeFolders[]` | 색인, 검색, 읽기, 나열에서 모두 빼는 폴더 이름. 대소문자와 앞뒤 공백은 구분하지 않습니다. `node_modules`, `.git` 같은 내장 제외는 항상 적용됩니다 |
| `qdrant.collection` | 벡터 컬렉션 이름. 환경 변수 `QDRANT_COLLECTION`이 우선합니다 |
| `data.schema` | 서버 테이블이 있는 Supabase 스키마 (기본 `public`) |
| `selfDomains[]` | 자사 도메인. 예약 항목이며 현재 도구는 읽지 않습니다 |
| `oauth.allowedDomains[]` / `oauth.allowedEmails[]` | Google 로그인을 허용할 대상. 환경 변수 `OAUTH_ALLOWED_HD`, `OAUTH_ALLOWED_EMAILS`가 우선합니다 |
| `access.viewerTools[]` | `app_users`에 없는 로그인 사용자에게 열 도구 묶음(`drive`, `slack`, `github`, `railway`). 기본은 없음 |

## 접근 권한

**누구인지**는 API 키나 Google 로그인으로 확인합니다. **무엇을 읽을 수 있는지**는 `app_users`의 행이 정합니다. 로그인만으로는 `ping` 외에 아무것도 열리지 않습니다.

| `app_users` 행 | 역할 | 쓸 수 있는 것 |
| --- | --- | --- |
| `role = 'admin'` | admin | 모든 도구 |
| 그 밖의 `role` 값 | engineer | `allowed_tools`의 도구 묶음, `allowed_drive_folders`의 Drive 폴더, `allowed_slack_channels`의 Slack 채널. 비어 있는 열은 그 항목에 제한이 없다는 뜻입니다 |
| 행 없음 | viewer | `ping`만 사용합니다. `access.viewerTools`로 연 도구 묶음은 예외입니다 |

<details>
<summary>API 키</summary>
<br>

1. 키는 `mcp_keys`에 SHA-256 해시로만 저장합니다. 길고 무작위한 키를 사용합니다.
2. 키를 막으려면 `active = false`로 바꾸거나 `expires_at`을 지정합니다. 막은 키는 `AUTH_CACHE_TTL_MS`(기본 60초) 동안 더 동작할 수 있습니다.
3. `email`이 있는 키는 역할과 범위를 `app_users`에서 가져옵니다. 그 행을 지우면 키의 권한도 내려갑니다. 이메일이 없는 키는 자기 `role` 열을 사용합니다.
4. 인증 실패는 클라이언트 IP마다 횟수를 제한합니다(기본 1분에 20회). 실제 IP를 보도록 프록시 구성에 맞춰 `TRUST_PROXY`를 설정합니다.

</details>

<details>
<summary>Claude 웹 커넥터용 OAuth</summary>
<br>

OAuth 환경 변수와 허용 목록을 설정하면, Google로 로그인하는 OAuth 2.1 서버가 켜집니다. 토큰을 내주기 전에 어떤 앱이 어디로 토큰을 받는지 보여 주는 동의 화면을 띄웁니다. 환경 변수가 없으면 API 키만 사용합니다. 자세한 설정은 [`OAUTH_SETUP.md`](OAUTH_SETUP.md)를 참고합니다.

</details>

<details>
<summary>데이터 원본별 접근 범위</summary>
<br>

| 원본 | 범위 |
| --- | --- |
| Drive | `drive.roots` 아래 파일에서 `drive.excludeFolders`와 사용자 `allowed_drive_folders` 밖을 뺀 범위. root 밖 파일 ID는 거부합니다 |
| Slack | 봇이 들어가 있는 채널. DM은 읽지 않습니다. 사용자 토큰은 검색에만 쓰고, 결과는 봇 채널로 거릅니다 |
| GitHub | 토큰이 읽을 수 있는 범위. 세분화된 토큰에 모든 사용자가 봐도 되는 저장소만 지정합니다 |
| Railway | 토큰이 읽을 수 있는 범위. 계정 토큰보다 프로젝트 토큰을 권장합니다 |

</details>

## 색인

`semantic_search_drive`는 Drive root를 색인한 Qdrant 데이터를 읽습니다.

| 할 일 | 방법 |
| --- | --- |
| 첫 전체 색인 | `docker compose run --rm reindex`, 소스로 실행할 때는 `npm run reindex` |
| 최신 상태 유지 | 서버가 30분마다 Drive 변경분을 반영합니다(`DRIVE_SYNC_INTERVAL_MIN`). 처음 실행한 시점부터 추적하므로 전체 색인을 먼저 실행합니다 |
| 정리 | 전체 실행은 목록에서 사라진 파일의 벡터를 지웁니다. 제외 폴더로 옮긴 파일이 여기에 해당합니다. `--root`, `--dev-only`, `--biz-only`로 범위를 좁힌 실행은 이 단계를 건너뜁니다 |
| 처음부터 다시 | `--recreate`는 컬렉션을 비우고 시작합니다. `--dry-run`은 청크 수만 셉니다 |

<details>
<summary>지원 형식과 제한</summary>
<br>

| 형식 | 텍스트 추출 방법 |
| --- | --- |
| Markdown, 일반 텍스트 | 그대로 사용 |
| Google 문서, 프레젠테이션 | Drive 내보내기 |
| Google 스프레드시트 | Drive CSV 내보내기. 첫 번째 시트만 |
| Word, PowerPoint, Excel | 로컬 파서 |
| 텍스트 층이 있는 PDF | 로컬 파서 |
| 스캔 PDF, PNG, JPEG, WebP | Mathpix OCR. `MATHPIX_APP_ID`와 `MATHPIX_APP_KEY`가 있을 때만 |

`DRIVE_MAX_FILE_BYTES`(기본 50MB)보다 큰 파일은 읽지도 색인하지도 않습니다. 임베딩은 OpenAI `text-embedding-3-small`(1536차원)을 사용합니다.

</details>

## 배포

이미지는 [`.github/workflows/docker.yml`](.github/workflows/docker.yml)이 GitHub Container Registry에 올립니다.

| 태그 | 기준 |
| --- | --- |
| `ghcr.io/chanthr/knowledge-mcp:latest` | 가장 최근 릴리스 태그 |
| `ghcr.io/chanthr/knowledge-mcp:<x.y.z>` | 릴리스 태그 `v<x.y.z>` |
| `ghcr.io/chanthr/knowledge-mcp:edge` | `main` 브랜치 |

1. **컨테이너 호스트.** 환경 변수와 함께 `MCP_CONFIG_JSON` 또는 `/app/mcp.config.json` 마운트로 실행합니다. [`compose.yaml`](compose.yaml)이 이 방식입니다. 호스트가 `PORT`를 지정해도 됩니다.
2. **Railway.** [`railway.toml`](railway.toml)이 Dockerfile로 빌드하고 `/health`를 확인합니다. 저장소에 없는 파일은 빌드에 들어가지 않으므로 설정은 `MCP_CONFIG_JSON`에 넣습니다.
3. **HTTPS.** 원격 클라이언트를 연결하기 전에 HTTPS 뒤에 둡니다. OAuth는 `localhost`가 아니면 `https` issuer가 필요합니다.
4. **인스턴스 하나.** 세션과 진행 중인 로그인은 메모리에 있습니다. 인스턴스를 하나만 실행하거나, 고정 라우팅과 공유 저장소를 직접 갖춰야 합니다.

## 클라이언트 연결

| 클라이언트 | 방법 |
| --- | --- |
| Claude Code | `claude mcp add --transport http knowledge https://<your-host>/mcp --header "Authorization: Bearer <key>"` |
| Claude 웹과 데스크톱 커넥터 | OAuth를 켠 뒤 `https://<your-host>/mcp`로 사용자 지정 커넥터를 추가합니다 |
| stdio를 쓰는 클라이언트 | `MCP_TRANSPORT=stdio`로 이미지를 실행합니다(아래 예시) |

<details>
<summary>stdio 설정 예시</summary>
<br>

stdio 모드는 시작할 때 `MCP_API_KEY`에서 키 하나를 읽습니다. 로컬에서는 `.env`의 `MCP_DEV_KEY`와 `MCP_API_KEY`를 같은 값으로 둡니다. 이 키는 관리자 권한이며 stdio 모드에서만 동작합니다.

```json
{
  "mcpServers": {
    "knowledge": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "--env-file", "/absolute/path/.env",
        "-e", "MCP_TRANSPORT=stdio",
        "-v", "/absolute/path/mcp.config.json:/app/mcp.config.json:ro",
        "ghcr.io/chanthr/knowledge-mcp:latest"
      ]
    }
  }
}
```

</details>

## 보안 유의사항

1. `.env`, `google-service-account.json`, `mcp.config.json`은 커밋하지 않습니다. 세 파일 모두 gitignore에 있고 이미지에도 들어가지 않습니다.
2. 업그레이드할 때마다 [`sql/setup.sql`](sql/setup.sql)을 다시 실행합니다. 행 수준 보안(RLS)을 켜고 `anon`, `authenticated` 권한을 회수해, 서비스 역할 키만 테이블에 접근하게 합니다.
3. 서버는 Drive, Slack, GitHub, Railway를 바꾸지 않습니다. 쓰기는 자체 Supabase 테이블과 Qdrant 색인에만 합니다.
4. 색인할 때 문서 본문을 OpenAI로 보내 임베딩을 만듭니다. OCR을 켜면 스캔 파일은 Mathpix로 보냅니다.
5. 토큰은 자기가 읽을 수 있는 범위 전체에 닿습니다. Slack 봇, GitHub 토큰, Railway 토큰은 이 서버의 모든 사용자가 봐도 되는 범위로 제한합니다.

## 파일 지도

| 구분 | 파일 | 내용 |
| --- | --- | --- |
| 서버 | [`src/index.ts`](src/index.ts) | 진입점. HTTP와 stdio 전송, 인증, 도구 라우팅 |
| 서버 | [`src/tools/`](src/tools/) | 도구마다 파일 하나 |
| 서버 | [`src/lib/`](src/lib/) | 인증, OAuth, 권한 범위, 설정, 색인, Qdrant, 텍스트 추출 |
| 서버 | [`src/integrations/`](src/integrations/) | Drive와 Slack API 클라이언트 |
| 색인 | [`scripts/index_drive.ts`](scripts/index_drive.ts) | Drive 전체 재색인 |
| 색인 | [`scripts/get_oauth_refresh_token.ts`](scripts/get_oauth_refresh_token.ts) | Drive OAuth 토큰을 한 번 발급받는 도우미 |
| 데⁠이⁠터⁠베⁠이⁠스 | [`sql/setup.sql`](sql/setup.sql) | 테이블, 키 확인 함수, 권한 잠금 |
| 설정 | [`.env.example`](.env.example), [`mcp.config.example.json`](mcp.config.example.json) | 모든 환경 변수, 설정 파일 양식 |
| 배포 | [`Dockerfile`](Dockerfile), [`compose.yaml`](compose.yaml), [`railway.toml`](railway.toml) | 이미지, 로컬 실행 구성, Railway |
| 문서 | [`OAUTH_SETUP.md`](OAUTH_SETUP.md) | OAuth 설정과 역할 |
| 저장소 | [`.github/`](.github/) | 이미지 워크플로, 이슈와 PR 양식, README 그림(`assets/make.py`로 다시 만듭니다) |

## 함께 고치기

문제나 개선할 점은 이슈로 남겨 주시기 바랍니다.

| 이슈 양식 | 이럴 때 사용합니다 |
| --- | --- |
| [**Bug report**](https://github.com/chanthr/internal-mcp/issues/new?template=01-bug.yml) | 동작이 코드나 문서와 다를 때 |
| [**Improvement**](https://github.com/chanthr/internal-mcp/issues/new?template=02-improvement.yml) | 더 나은 방법이 있거나 문서가 코드와 맞지 않을 때 |

이 저장소는 공개 저장소입니다. 이슈와 PR에 API 키, 토큰, 내부 주소, 비공개 문서를 쓰지 않습니다. 보안 문제는 공개 이슈 대신 Security 탭의 [**Report a vulnerability**](https://github.com/chanthr/internal-mcp/security/advisories/new)로 비공개 제보해 주시기 바랍니다.

## 라이선스

[MIT](LICENSE) © chanthr
