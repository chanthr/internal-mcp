<h1 align="center">
  <img alt="Knowledge MCP" src=".github/assets/ko/banner.svg" width="100%">
</h1>

<p align="center">
  <a href="LICENSE"><img alt="license: MIT" src=".github/assets/badge-license.svg"></a>
  <a href="#빠른-시작"><img alt="node: 22.13+" src=".github/assets/badge-node.svg"></a>
  <a href="#클라이언트-연결"><img alt="MCP: HTTP + stdio" src=".github/assets/badge-mcp.svg"></a>
  <a href="#접근-권한"><img alt="auth: Key + OAuth" src=".github/assets/badge-auth.svg"></a>
</p>

<p align="center">
  <b>우리 팀만의 MCP 서버를 만듭니다. 설치는 명령 한 줄, 도구 추가는 파일 하나입니다.</b><br>
  API 키, Google 로그인, 사람별 권한, 호출 기록은 이미 들어 있습니다.<br>
  문서 검색(로컬 폴더, Google Drive), Slack, GitHub, Railway 연결도 기본으로 들어 있습니다.<br>
  데이터베이스와 API는 설정 몇 줄로 도구가 됩니다.
</p>

<p align="center">
  <a href="README.md">English</a>&nbsp;&nbsp;|&nbsp;&nbsp;<b>한국어</b>
</p>

<p align="center">
  <a href="#빠른-시작"><b>빠른 시작</b></a>&nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp;
  <a href="#도구-추가">도구 추가</a>&nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp;
  <a href="#플러그인-api">플러그인 API</a>&nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp;
  <a href="#기본-플러그인">기본 플러그인</a>&nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp;
  <a href="#접근-권한">접근 권한</a>&nbsp;&nbsp;&nbsp;|&nbsp;&nbsp;&nbsp;
  <a href="#배포">배포</a>
</p>

## 빠른 시작

원하는 쪽을 고릅니다. 두 방법 모두 따로 준비할 데이터베이스가 없습니다. 상태는 로컬 SQLite 파일에 저장합니다.
Node 22.13 이상이나 Docker가 필요합니다.

| 원하는 것 | 시작 방법 |
| --- | --- |
| **브라우저에서 눌러 가며 설정하기** | 아무 폴더에서 `npx @chnxthr/knowledge-mcp`. [콘솔](#콘솔)이 열립니다 |
| **내 도구 만들기** (사내 API, 데이터베이스 등 무엇이든) | `npx create-knowledge-mcp my-mcp` |
| **데이터베이스나 API에 질문하기**, 코드 없이 | [내 데이터를 도구로](#내-데이터를-도구로): 설정에 연결과 질의를 적습니다 |
| **기본 연결만 쓰기** (Drive, Slack, GitHub, Railway) | Docker 이미지 |

**내 도구 만들기**

```bash
npx create-knowledge-mcp my-mcp
cd my-mcp
npm run dev                                                   # http://localhost:8080/mcp, 저장하면 다시 뜸
```

생성기는 안내형 설정으로 이어집니다. 어떤 서비스를 연결할지 묻고, 키를 넣는 즉시 실제 서비스에 붙어 확인하고,
`.env`와 `mcp.config.json`을 쓰고, 관리자 키를 만들고, Claude Code에 서버를 추가해 줍니다. 손으로 고칠 파일이
없습니다. 언제든 다시 실행할 수 있습니다.

```bash
npm run setup
```

AI 에이전트에게 맡겨도 됩니다. 프로젝트에 에이전트용 설정 안내서 [`AGENTS.md`](packages/create-knowledge-mcp/template/AGENTS.md)가
들어 있습니다. 폴더를 Claude Code로 열고 "AGENTS.md를 따라 이 서버를 설정해 줘"라고 하면 됩니다. 에이전트는 설정 명령을
실행하고, 계정에 무언가를 만들기 전에 묻고, 비밀값은 다루지 않습니다.

**문서 검색부터 해 보십시오.** 문서 폴더 하나면 됩니다. 계정도 키도 필요 없습니다.

```bash
npm run setup -- folder ~/Documents/handbook   # Markdown, 텍스트, PDF, Word, PowerPoint, Excel
npm run dev
```

서버가 뜨면서 폴더를 색인하고, `search_knowledge`가 키워드로 답합니다. 한국어와 영어 모두 됩니다.
임베딩 모델은 나중에 넣어도 됩니다. 문서를 다시 읽지 않고 뜻으로 찾는 검색이 더해집니다. Drive를 연결하면
Drive 문서도 같은 색인에 들어갑니다.

프로젝트에는 예시 플러그인 `src/plugins/notes.ts`가 들어 있습니다. 클라이언트를 `http://localhost:8080/mcp`에
`Authorization: Bearer <키>`로 연결하면 `notes_add`와 `notes_list`가 보입니다.

**기본 연결만 쓰기**

```bash
cp .env.example .env                         # 쓸 연결의 값을 채움
cp mcp.config.example.json mcp.config.json   # Drive 폴더, 제외 폴더, 로그인 허용 목록
docker run -d --name kmcp -p 8080:8080 -v kmcp-data:/data --env-file .env \
  -v "$PWD/mcp.config.json:/app/mcp.config.json:ro" ghcr.io/chanthr/knowledge-mcp:latest
docker exec kmcp knowledge-mcp keys create --email you@example.com --role admin
docker exec kmcp knowledge-mcp doctor        # 어떤 연결이 켜졌는지, 꺼진 연결은 무엇이 빠졌는지
```

환경변수는 [`.env.example`](.env.example)에 모두 있습니다. 각 연결은 자기 환경변수가 채워지면 켜집니다.
이미지에는 설정이 들어 있지 않습니다. 위처럼 `mcp.config.json`을 연결하거나 `-e MCP_CONFIG_JSON='{…}'`로 넘깁니다.
[`compose.yaml`](compose.yaml)은 같은 일을 Docker Compose로 합니다.

## 콘솔

설정 명령이 하는 일을 브라우저 화면에서 합니다. 터미널에서 서버를 띄우면 주소가 나옵니다.

```bash
npx @chnxthr/knowledge-mcp     # 아무 폴더에서: 설정이 그 폴더에 저장되고 콘솔이 열립니다
npm run dev                    # 생성한 프로젝트에서: 첫 몇 줄에 주소가 나옵니다
```

![콘솔: 무엇이 연결됐고 잘 되는지](.github/assets/console-overview.png)

| 화면 | 하는 일 |
| --- | --- |
| Documents | 파일이나 폴더를 화면에 끌어다 놓아 복사해 넣고, 폴더를 있는 자리 그대로 추가하고(컴퓨터의 폴더 선택 창에서 고르거나 경로를 입력), Google Drive를 연결하고(구글 로그인, gcloud로 서비스 계정 만들기, 키 붙여넣기), 의미 검색을 켭니다. 임베딩 모델은 엔드포인트가 가진 목록에서 고릅니다(로컬 Ollama, OpenAI, 호환 엔드포인트). 나중에 바꿀 수 있습니다. 새 벡터는 저장된 글에서 만들고 진행 상황이 화면에 나옵니다 |
| Graph | 문서가 서로 어떻게 가리키는지 보여 줍니다. 사람이 적은 링크로 만듭니다. 가장 많이 가리켜지는 문서, 한 문서의 주변, 정리할 것(없는 문서를 가리키는 링크, 아무 연결이 없는 문서)이 나옵니다 |
| Databases and APIs | Postgres, SQLite, HTTP API를 연결합니다. 질의를 한 번 써서 도구로 저장합니다. 화면이 테이블 목록을 보여 주고, 저장하기 전에 실제 데이터베이스에서 질의를 점검합니다 |
| Apps | Slack, GitHub, Railway를 연결합니다. 로그인이 되는 곳은 로그인으로, 아니면 토큰으로 연결합니다. 자체 MCP 서버가 있는 앱(Notion, Supabase, Linear, Sentry 등)도 추가합니다. 그 앱에서 로그인하면 읽기 도구가 앱 이름을 달고 들어옵니다 |
| Agent | 서버가 스스로 하는 일에 쓸 언어 모델을 연결합니다. Claude(Anthropic), OpenRouter, OpenAI, Ollama로 띄운 로컬 모델, OpenAI의 chat completions를 말하는 엔드포인트라면 무엇이든 됩니다. 모델은 제공자가 내놓는 목록에서 고르고, 저장하기 전에 질문 하나로 확인합니다. 모델을 연결하기 전에는 서버가 어떤 모델도 부르지 않습니다 |
| Chat | Agent 화면에 연결한 모델에게 묻고, 이 서버의 도구로 답하는 과정을 봅니다. 도구를 부를 때마다 무엇을 받았는지 바로 보입니다. 모델은 읽기만 하는 도구와 모든 클라이언트가 받는 안내문을 받습니다. 대화는 저장하지 않습니다 |
| Tools | AI 클라이언트가 부를 수 있는 도구 전부입니다. 값을 넣고 실행하면 클라이언트가 받는 결과가 그대로 보입니다 |
| Connect a client | 버튼 하나로 Claude Code, Claude Desktop, Cursor, VS Code에 이 서버를 추가합니다. 이미 추가된 곳도 보여 줍니다. 직접 넣을 항목도 복사할 수 있습니다 |
| People and keys | 키를 만들고 취소합니다. 사람마다 쓸 수 있는 도구를 정합니다 |
| Activity | 최근 도구 호출입니다. 누가, 언제, 얼마나 걸렸고, 성공했는지 보여 줍니다 |

![콘솔: 도구를 실행해 보기](.github/assets/console-tools.png)

저장한 변경은 저절로 적용됩니다. 서버가 다시 시작하고 화면은 기다립니다. 모든 값은 실제 서비스에 확인한 뒤에
씁니다. 설정 명령과 같은 `.env`와 `mcp.config.json`에 쓰므로 콘솔과 명령을 섞어 써도 됩니다.

### 토큰을 옮겨 적지 않고 연결하기

다른 사이트의 설정 화면에서 토큰을 만들어 옮겨 적는 일이 설정에서 가장 오래 걸립니다. 서비스가 더 나은 방법을
제공하면 콘솔이 그 방법을 씁니다.

| 서비스 | 콘솔에서 | 필요한 것 |
| --- | --- | --- |
| Railway | **Sign in with Railway** | 준비할 것이 없습니다. 서버가 Railway에 스스로 등록하고, 사용자는 로그인해서 읽게 할 워크스페이스를 고릅니다. 권한은 보기 전용입니다. 로그인은 저절로 갱신됩니다 뷰어는 프로젝트와 배포 상태까지 봅니다. 로그는 Railway가 멤버에게만 보여 주므로, **Also read logs**를 켜면 멤버 권한을 요청합니다(멤버는 변경도 할 수 있는 권한입니다. 이 서버는 읽기만 합니다) |
| Google Drive | **Sign in with Google** | 본인 Google Cloud 프로젝트의 OAuth 클라이언트가 필요합니다. 한 번 만들어 클라이언트 ID와 비밀값을 넣습니다. 그 뒤 서버는 로그인한 사람의 내 드라이브나 고른 폴더를 읽습니다. 구글은 Drive를 읽는 공용 앱을 모두 심사하기 때문에 미리 만들어 둔 앱을 제공할 수 없습니다 |
| Google Drive | **Account with gcloud** | Homebrew나 winget이 있는 컴퓨터라면 준비할 것이 없습니다. 콘솔이 gcloud CLI를 설치하고 로그인 명령을 실행합니다(브라우저 창이 열립니다). 그다음 gcloud가 서비스 계정과 키를 만듭니다. 그 계정에 폴더를 공유하면 됩니다. 조직 계정에 Google이 다시 로그인을 요구하면 콘솔이 로그인을 다시 실행합니다 |
| Notion, Supabase, Linear 등 MCP 서버가 있는 앱 | **Add an app** | 앱의 서버가 MCP 로그인 규칙을 따르면 준비할 것이 없습니다. 서버가 그 앱에 스스로 등록하고, 사용자는 그 앱에서 로그인합니다. 읽는 도구만 켜지고, Supabase는 읽기 전용 모드로 추가됩니다 |
| GitHub | **Connect with the gh CLI** | Homebrew나 winget이 있는 컴퓨터라면 준비할 것이 없습니다. 버튼 하나로 gh CLI를 설치하고, github.com에 입력할 코드로 로그인한 뒤, 그 로그인을 씁니다. gh가 이미 로그인돼 있으면 **Use the gh login**으로 나옵니다 |
| Slack | 읽기 권한이 채워진 채로 Slack의 앱 만들기 화면을 여는 링크 | 봇 토큰은 한 번 복사해야 합니다. Slack 로그인은 비밀값과 공개 https 주소를 요구하는데, 내 컴퓨터의 서버에는 둘 다 없습니다 |

이 도구들 때문에 터미널로 가지 않아도 됩니다. 콘솔이 명령을 직접 실행하고 기다립니다. `brew install gh`, `brew install --cask gcloud-cli`(Windows는 winget), `gcloud auth login`, `gh auth login --web`입니다. 설치는 실행할 명령을 먼저 보여 주고, 진행 상황을 보여 줍니다. 명령은 정해져 있고, 화면에 입력한 값은 명령줄에 들어가지 않습니다. 아는 패키지 관리자가 없으면 도구의 설치 안내로 연결합니다.

서비스마다 토큰을 붙여 넣는 방법도 그대로 있습니다. 환경변수 `RAILWAY_TOKEN`이 있으면 로그인보다 먼저 씁니다.
개인 구글 계정이면 OAuth 동의 화면을 게시하십시오(심사를 받지 않은 상태로 두어도 본인 용도에는 문제없습니다).
"테스트" 상태로 두면 구글이 7일마다 로그인을 끊습니다.

콘솔은 그 컴퓨터 앞에 앉은 사람을 위한 화면입니다. 서버를 터미널에서 띄웠을 때만 제공합니다. 서비스, 컨테이너,
프로세스 관리자로 띄운 서버에는 없습니다(`KNOWLEDGE_CONSOLE=on`으로 켤 수 있습니다). 같은 컴퓨터의 브라우저가
`localhost`로 요청할 때만 응답합니다. API는 서버가 처음 시작할 때 만든 토큰(`<데이터 폴더>/console-token`)이 있어야
하고, 토큰은 주소에 붙어 나옵니다. 화면은 비밀값을 보여 주지 않습니다. 토큰이 설정됐다는 사실만 보여 줍니다.
콘솔 토큰을 가진 사람은 이 서버의 관리자입니다. 비밀번호처럼 다루십시오. `KNOWLEDGE_CONSOLE=off`로 끕니다.

### 문서로 쓰는 위키

검색은 질문마다 조각을 다시 찾습니다. 위키는 이해한 것을 남겨 둡니다. Agent 화면에서 모델을 연결하면 서버가 문서를 읽고 위키를 씁니다. 설정 옆 `wiki/` 폴더에 일반 Markdown으로 저장합니다.

```
wiki/
  AGENTS.md    이 위키의 규칙. 문서에서 무엇을 가져올지, 어떤 언어로 쓸지. 직접 고칠 수 있습니다
  index.md     모든 페이지를 한 줄씩
  log.md       무엇을 언제 읽었는지
  sources/     문서마다 한 페이지. 그 문서가 말하는 것과 연결되는 주제
  topics/      주제마다 한 페이지. 모든 문서가 그 주제에 대해 말하는 것. 사실마다 출처 문서가 붙습니다
```

| | |
| --- | --- |
| 시작 | **Wiki → Create the wiki**, 이어서 **Read documents**. 한 번에 문서를 25개까지 읽고, 더 읽기 전에 얼마나 들었는지(질문 수, 들어간 토큰과 나온 토큰) 보여 줍니다 |
| 읽는 대상 | 폴더와 `uploads/`에 있는 문서. 문서는 바꾸지 않습니다. 바뀐 문서만 다시 읽고, 지워진 문서가 말한 것은 위키에서도 빠집니다 |
| 드는 것 | 문서마다 모델에 질문 한 번(긴 문서는 나눠 읽어 더 듭니다), 사실이 셋 이상 모인 주제 페이지마다 한 번 |
| 어디에 나타나나 | 위키는 이 서버의 폴더입니다. `search_knowledge`와 `read_document`가 그 페이지를 찾고, Graph 화면과 `linked_documents`가 주제에서 문서로, 문서에서 주제로 링크를 따라갑니다 |
| 옵시디언 | `wiki/`를 볼트로 열면 됩니다. 페이지는 `[[…]]`로 연결되고 파일 이름이 제목입니다 |
| 내 메모 | 페이지의 `## Notes` 제목 아래에 적은 것은 페이지를 다시 쓸 때도 남습니다 |
| 작은 모델이나 로컬 모델 | 됩니다. 모델에게 JSON이 아니라 이름표가 붙은 줄로 답하게 합니다. 모델의 창이 작으면 `WIKI_PART_CHARS`(기본 24000)를 낮추십시오. 페이지의 정확도는 문서를 읽은 모델만큼입니다 |
| 저절로 최신으로 | Wiki 화면의 **Keep the wiki up to date**를 켜면, 그 뒤에 더해지거나 바뀐 문서를 폴더를 훑을 때마다 읽습니다. 하루 50개까지입니다. 켤 때 쌓여 있던 문서는 버튼으로 읽으므로, 많이 쌓여 있어도 모델 사용량을 저절로 쓰지 않습니다 |
| 읽다가 실패하면 | 문서를 하나 읽을 때마다 그 페이지와 log 한 줄을 바로 씁니다. 중간에 서버가 다시 시작돼도 잃는 것이 없고, 빠진 페이지는 저장해 둔 내용으로 모델 없이 다시 씁니다. 모델이 바쁘거나 요청을 제한하면 잠시 뒤 다시 묻습니다(API와 ChatGPT 요금제 모두 같은 방식). 계속 실패하는 문서는 이유와 함께 보여 주고 바뀔 때까지 건너뜁니다. 읽기 시작한 문서는 성공하든 실패하든 하루 상한에 셉니다. 키나 요금제 한도처럼 매번 걸릴 실패가 나거나 Stop 을 누르면 자동 읽기를 1시간 쉬고, 끄면 읽던 것도 멈춥니다. 지금 목록을 읽을 수 없는 폴더의 페이지는 지우지 않습니다 |

### 검색 도우미

`search_knowledge`는 검색 한 번에 답합니다. 여러 부분으로 된 질문이나 문서와 다른 말로 한 질문은 검색이 여러 번
필요할 때가 많습니다. `find_documents`는 이런 질문을 검색 도우미에게 넘깁니다. 검색 도우미는 여러 번 검색하고,
발췌로 모자라면 문서를 읽은 뒤, 답이 든 문서를 순서대로 돌려줍니다. 문서마다 무엇이 들었는지 한 줄을 붙입니다.
답은 쓰지 않습니다. 물어본 모델이 그 문서를 읽고 답합니다. 찾는 모델과 답하는 모델을 나누는 에이전트 검색 모델과
같은 구조입니다.

| | |
| --- | --- |
| 모델 | 언어 모델을 그대로 쓰거나, **Models → Search assistant**에서 검색용 모델을 따로 정합니다. 채팅은 상용 모델로, 검색은 이 컴퓨터의 모델로 돌리는 식입니다. 위의 제공자 모두 됩니다 |
| 보는 것 | 문서의 발췌와 일부. `search_knowledge`와 `read_document`의 점검을 그대로 거칩니다. 제외한 폴더는 빠지고, 물어본 사람이 볼 수 있는 폴더만 봅니다 |
| 노력 단계 | `low`: 검색 3회차. `medium`(기본): 6회차. `high`: 질문을 부분으로 나눠 부분마다 도우미가 동시에 찾고, 결과를 순위로 합칩니다 |
| 비용 | 부르는 사람이 누구든 서버의 모델을 씁니다. 한 사람은 동시에 2개, 한 시간에 60개까지 묻습니다. 도우미 하나는 한 회차에 6번까지 호출하고 8만 자까지 읽습니다. 질문 하나는 5분이 지나면 멈춥니다 |
| 재 보기 | **Search → Passages → Measure with it**은 측정 질문을 키워드, 뜻 검색과 함께 검색 도우미에게도 묻고, 걸린 시간과 토큰을 보여 줍니다. 터미널에서는 `knowledge measure --agent` |

### 대화, 노트, 다른 프로그램이 보내는 것

채팅은 대화를 이 컴퓨터에 남깁니다(`data/chats/`, 본인만 읽음). 화면 위쪽 목록에서 골라 이어 쓰거나 새로 시작합니다.
화면을 나가도 답은 멈추지 않고, 돌아오면 그대로 있습니다. 긴 대화는 최근 6만 자만 모델에 보냅니다(`CHAT_HISTORY_CHARS`).

채팅에 무언가를 남겨 달라고 하면(읽은 강의 자료로 만든 노트 같은 것) `save_note`를 부릅니다. 노트는 설정 옆 두 폴더에
Markdown 파일로 저장되고, 다른 폴더처럼 검색되고 위키로 읽히며, 옵시디언에서 열립니다.

| 폴더 | 들어가는 것 |
| --- | --- |
| `notes/` | 콘솔 채팅이 저장한 것. 직접 고쳐도 됩니다 |
| `inbox/<보낸 계정>/` | 다른 AI 클라이언트(Claude, ChatGPT, Cursor)가 `save_note`로 저장한 것, 프로그램이 `POST /inbox`로 보낸 것. 폴더는 노트가 스스로 밝힌 출처가 아니라, 보낸 키의 계정으로 정해집니다 |

노트는 다른 파일을 덮어쓰지 않고, `save_note`가 바꿀 수 있는 것은 부른 쪽 자기 폴더의 노트뿐입니다. 사용자의 문서는
바뀌지 않고, 링크를 따라 쓰지도 않습니다. 바뀐 노트의 이전 내용은 옆의 숨김 폴더 `.versions/`에 남습니다. viewer는
저장할 수 없습니다. 채팅은 읽기 도구와 `save_note`만 씁니다. `inbox/`는 검색되지만 위키에는 넣지 않습니다. 다른
프로그램이 보낸 내용을 사용자의 문서가 말한 것처럼 정리하지 않기 위해서입니다. 설정 폴더에 쓸 수 없으면(설정을 읽기
전용으로 붙인 컨테이너) 두 폴더는 데이터 폴더에 둡니다. `notes`, `inbox`라는 이름은 이 폴더 몫이라, 같은 이름으로
설정한 폴더에는 번호가 붙습니다(`notes-2`).

MCP를 쓰지 않는 프로그램(브라우저 에이전트 Aside의 예약 루틴, 스크립트 등)은 member나 admin의 키로 보냅니다.

```bash
curl -X POST https://<내 주소>/inbox \
  -H "Authorization: Bearer <키>" -H "Content-Type: application/json" \
  -d '{"title": "강의 페이지 4주차", "content": "과제 2는 금요일까지.", "from": "aside", "url": "https://school.example/week-4"}'
```

`201 {"saved": "inbox/<보낸 계정>/2026-11-20 강의 페이지 4주차.md"}`로 답합니다. 항목은 `title`, `content`(Markdown,
20만 자까지), 그리고 선택으로 `from`(노트에 `via`로 남음), `url`, `tags`입니다. Aside 루틴에서는 작업 끝에 이렇게 적습니다.
*"찾은 내용을 Knowledge MCP로 보내. https://<내 주소>/inbox 에 Authorization: Bearer <키> 헤더를 붙여 POST하고,
title, content(Markdown), from: "aside"를 JSON으로 보내."*

## 동작 방식

<p align="center">
  <img alt="동작 방식: 만들기, 도구 추가, 권한 확인, 사용" src=".github/assets/ko/flow.svg" width="100%">
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/ko/parts-dark.svg">
  <img alt="구성: 코어(기본 제공), 플러그인(직접 씀), 게이트웨이(설정만), 저장소(기본 제공)" src=".github/assets/ko/parts-light.svg" width="100%">
</picture>

<details>
<summary>표로 보기</summary>
<br>

| 구성 | 하는 일 | 직접 쓰나요? |
| --- | --- | --- |
| 코어 | HTTP와 stdio 연결, API 키, Google 로그인 OAuth 2.1, 역할, 호출 기록, 로그 속 비밀값 가리기 | 아니요 |
| 플러그인 | 연결 하나씩 맡습니다. 도구, 필요한 환경변수, 권한 그룹을 정합니다 | 예, 플러그인 하나에 파일 하나 |
| 게⁠이⁠트⁠웨⁠이 | 다른 MCP 서버(GitHub, Notion, 직접 만든 서버)를 이름 접두어를 붙여 대신 엽니다. 기본은 읽기 전용입니다 | 설정만 |
| 저장소 | 키, 사용자, OAuth 토큰, 플러그인 상태, 호출 기록. 기본은 SQLite 파일, Supabase도 됩니다 | 아니요 |

</details>

<details>
<summary>요청 하나가 처리되는 순서</summary>
<br>

| 단⁠계 | 주체 | 하는 일 |
| :---: | --- | --- |
| 1 | 클라이언트 | `Authorization: Bearer <API 키 또는 OAuth 토큰>`으로 `/mcp`를 부릅니다. |
| 2 | 코어 | 저장된 해시로 키를 확인하거나 OAuth 토큰을 검증합니다. 그다음 그 사람의 역할과 제한을 불러옵니다. |
| 3 | 코어 | 설정이 끝난 플러그인 중 그 사람에게 허용된 도구만 목록에 올립니다. |
| 4 | 플러그인 | 검증된 입력과 호출한 사람을 받아 일을 하고 글이나 JSON을 돌려줍니다. 호출은 기록됩니다. |

</details>

## 도구 추가

`src/plugins/` 안의 파일 하나가 플러그인 하나입니다. 예시를 복사해 고칩니다.

```ts
// src/plugins/weather.ts
import { definePlugin, defineTool, ToolError, z } from '@chnxthr/knowledge-mcp';

export default definePlugin({
  id: 'weather',                    // 권한 그룹 이름도 됩니다
  env: ['WEATHER_API_KEY'],         // 이 값이 없으면 도구가 목록에 나오지 않습니다
  tools: [
    defineTool({
      name: 'weather_now',
      description: '도시의 현재 날씨. 오늘 날씨를 묻는 질문에 씁니다.',
      input: z.object({ city: z.string().describe('도시 이름, 예: Seoul') }),
      annotations: { readOnlyHint: true },
      run: async ({ city }, ctx) => {
        const r = await fetch(`https://api.example.com/weather?q=${encodeURIComponent(city)}`, {
          headers: { Authorization: `Bearer ${process.env.WEATHER_API_KEY}` },
        });
        if (r.status === 404) throw new ToolError(`${city} 라는 도시가 없습니다`);
        ctx.log(`weather for ${city} by ${ctx.user.email}`);
        return r.json();            // JSON 값은 보기 좋은 JSON 글로 나갑니다
      },
    }),
  ],
});
```

파일을 저장하면 개발 서버가 다시 뜹니다. `src/plugins/`에 새로 만든 파일도 잡습니다. 라우터, 도구 목록,
권한 표는 건드리지 않습니다.

| 코어가 대신 하는 일 | 방법 |
| --- | --- |
| 도구 목록에 올리기 | `name`, `description`, zod `input`(zod 3, 4 모두)을 JSON Schema로 바꿉니다 |
| 설정 전에는 숨기기 | `env`에 적은 값이 모두 채워질 때까지 숨깁니다. `enabled()`를 쓰면 그 조건도 봅니다 |
| 입력 검증 | 잘못된 입력에는 `[invalid_input] tool '<이름>': 항목: 이유`를 돌려주고 `run`은 부르지 않습니다 |
| 권한 확인 | 플러그인 `id`가 권한 그룹입니다([접근 권한](#접근-권한) 참고) |
| 결과 모양 맞추기 | 문자열은 글로, 그 밖의 값은 JSON 글로 보냅니다. MCP 결과 형식은 그대로 보냅니다 |
| 오류 처리 | `throw new ToolError('...')`는 `[error] ...`, 그 밖의 오류는 `[fatal] ...`로 돌려줍니다 |
| 호출 기록 | 도구, 사람, 역할, 성공 여부, 걸린 시간을 남깁니다. 입력값은 남기지 않습니다 |

## 내 데이터를 도구로

데이터베이스나 사내 API는 플러그인 파일 없이 도구가 됩니다. 연결에 이름을 붙이고, 무엇을 물을 수 있는지
적습니다. 둘 다 `mcp.config.json`에 적고, 비밀값은 `.env`에 둡니다.

```json
{
  "connections": {
    "shop": { "type": "postgres", "urlEnv": "SHOP_DATABASE_URL", "description": "주문과 고객" },
    "crm": { "type": "http", "baseUrl": "https://crm.example.com/api/v2", "headers": { "Authorization": "Bearer ${CRM_TOKEN}" } }
  },
  "tools": [
    {
      "name": "orders_by_customer",
      "connection": "shop",
      "description": "고객 한 명의 주문을 최근 순으로 보여 줍니다. 고객이 무엇을 샀는지 물을 때 씁니다.",
      "params": {
        "email": { "type": "string", "description": "고객 이메일" },
        "limit": { "type": "integer", "default": 20, "min": 1, "max": 100 }
      },
      "sql": "select id, total, status, created_at from orders where email = :email order by created_at desc limit :limit"
    },
    {
      "name": "crm_contact",
      "connection": "crm",
      "description": "CRM 연락처 하나를 id로 찾습니다.",
      "params": { "id": { "type": "string" } },
      "request": { "path": "/contacts/{id}", "pick": "data" }
    }
  ]
}
```

```bash
npm run setup -- connection shop --postgres --env SHOP_DATABASE_URL   # 연결을 설정에 적습니다
npm run setup -- secret SHOP_DATABASE_URL                             # 접속 주소를 화면에 보이지 않게 .env에 넣습니다
npm run setup -- check                                                # 접속하고, 적어 둔 질의를 모두 컴파일해 봅니다
```

`setup check`는 데이터베이스에 접속해 적어 둔 질의를 하나씩 컴파일해 봅니다. 열 이름이 틀리면 모델이 도구를
부르기 전에 알 수 있습니다. 실행하는 것은 없습니다. 설정은 서버가 뜰 때 읽습니다. `npm run dev`는
`mcp.config.json`이나 `.env`가 바뀌면 다시 뜹니다.

**질의를 AI에게 맡길 수도 있습니다.** 데이터베이스 연결에 `"explore": true`를 적으면 도구 두 개가 더 생깁니다.
`shop_tables`는 표와 열을 보여 주고, `shop_query`는 읽기 전용 SELECT 하나를 실행합니다. 미리 만들어 둔 도구가
없는 질문에도 답할 수 있습니다. `npm run setup`에서 Database를 고르면 이 선택을 묻습니다.

| 안전장치 | 방법 |
| --- | --- |
| 값은 SQL 글자가 되지 않습니다 | `:name`은 데이터베이스 드라이버가 값으로 묶습니다. 호출자가 무엇을 넣든 데이터입니다 |
| 읽기 전용 도구는 쓰지 못합니다 | Postgres는 읽기 전용 트랜잭션에서 질의 하나만 실행하고 되돌립니다. 서버가 문장을 하나만 받습니다. SQLite는 파일을 읽기 전용으로 엽니다. 질의를 어떻게 쓰든 데이터베이스가 쓰기를 거절합니다 |
| 질문 하나가 표나 서버를 차지하지 못합니다 | 행 제한(`maxRows`, 기본 100)은 데이터베이스가 적용하고, 시간 제한(`timeoutMs`, 기본 10초)이 질의를 멈춥니다. 답의 크기도 제한합니다. 긴 값은 4,000자에서 자르고, Postgres 결과가 16MB를 넘으면 버리고, SQLite 질의는 한 번에 4개까지만 돕니다 |
| API 도구는 그 API를 벗어나지 못합니다 | 매개변수는 경로 한 칸, 쿼리 값, 헤더 값, JSON 필드 하나를 채웁니다. 호스트와 기본 경로는 고정이고 리다이렉트는 따라가지 않습니다 |
| 비밀값은 밖으로 나가지 않습니다 | `${ENV_NAME}` 값은 답 어디에 나오든 가립니다. 요청을 그대로 되돌려 주는 API 오류가 그런 경우입니다. 매개변수로 비밀값을 끌어올 수도 없습니다. 넣은 값은 다시 템플릿으로 읽지 않습니다 |
| 누가 부를 수 있나 | 연결 이름이 플러그인 id처럼 권한 그룹입니다([접근 권한](#접근-권한)). tools 목록이 없는 member는 모든 그룹을 쓸 수 있고, 새 연결도 포함됩니다 |
| 무엇을 읽을 수 있나 | 데이터베이스 사용자가 읽을 수 있는 것 전부입니다. `explore`에서는 더 그렇습니다. 이 연결만 쓰는 사용자를 따로 만드십시오. 읽기만 되고, 이 서버를 쓰는 모두가 봐도 되는 것만 읽는 사용자여야 합니다. superuser는 안 되고, 애플리케이션이 쓰는 사용자도 안 됩니다. 질의는 같은 사용자의 다른 세션을 끊을 수 있습니다 |

<details>
<summary>연결, 도구, 매개변수 전체</summary>
<br>

| 연결 | 필드 |
| --- | --- |
| `postgres` | `urlEnv`(`postgres://user:password@host:5432/db`가 든 환경변수의 이름), `explore`, `maxRows`, `timeoutMs`, `pool`(열어 두는 접속 수, 기본 3), `description` |
| `sqlite` | `path`(절대 경로 또는 프로젝트 기준 상대 경로), `explore`, `maxRows`, `timeoutMs`, `description`. 질의마다 잠깐 사는 자식 프로세스에서 돌려서 느린 질의를 멈출 수 있습니다. 서버가 죽으면 자식도 스스로 끝납니다 |
| `http` | `baseUrl`, 모든 요청에 붙는 `headers`와 `query`(값에 `${ENV_NAME}`을 쓸 수 있습니다), `timeoutMs`(기본 15초), `maxBytes`(읽을 응답 크기 상한, 기본 1MB), `description` |

| 도구 필드 | 뜻 |
| --- | --- |
| `name`, `description` | 모델이 보는 것입니다. 모델은 설명을 보고 도구를 고릅니다. 무엇에 답하고 언제 쓰는지 적으십시오 |
| `connection` | 도구가 쓰는 연결 |
| `params` | `{ 이름: { type, description, required, default, enum, min, max, maxLength, pattern } }`. `type`은 `string`, `integer`, `number`, `boolean` 가운데 하나입니다. `default`가 있으면 선택 항목입니다. 값이 없는 선택 항목은 SQL에서 NULL이고, 요청에서는 빠집니다 |
| `sql` | 문장 하나. 매개변수 자리에 `:name`을 씁니다(데이터베이스 연결) |
| `request` | `{ method, path, query, headers, body, pick }`(http 연결). `{name}`에 매개변수가 들어갑니다. `body`에서 값이 정확히 `{name}`이면 매개변수의 형식 그대로 들어갑니다. `pick`은 JSON 응답의 한 부분만 남깁니다(예: `data.items`) |
| `readOnly` | SQL은 기본 `true`입니다. 데이터를 바꾸는 도구라면 `false`로 적습니다. HTTP는 GET이 기본 `true`이고, 다른 메서드는 `true`나 `false`를 꼭 적어야 합니다 |
| `maxRows`, `timeoutMs` | 이 도구만 연결의 제한과 다르게 둡니다 |

| 명령 | 하는 일 |
| --- | --- |
| `knowledge-mcp setup connection <이름> --postgres --env NAME [--explore]` | Postgres 연결을 추가합니다. 접속 주소는 인자로 받지 않습니다 |
| `knowledge-mcp setup connection <이름> --sqlite <파일> [--explore]` | SQLite 파일을 추가합니다 |
| `knowledge-mcp setup connection <이름> --http <기본 URL> --header 'Authorization: Bearer ${API_TOKEN}'` | API를 추가합니다. 비밀값으로 보이는 헤더와 쿼리 값은 `${ENV_NAME}`으로 적어야 합니다 |
| `knowledge-mcp setup secret <ENV_NAME>` | 비밀값 하나를 화면에 보이지 않게 `.env`에 넣습니다(터미널 필요) |
| `knowledge-mcp <이름> tables [필터]` | 연결이 읽을 수 있는 표와 열을 보여 줍니다. 도구를 쓸 때 봅니다 |
| `knowledge-mcp <이름> check` | 연결 하나와 그 도구를 점검합니다 |

설정 안의 실수(질의가 쓰지 않는 매개변수, 둘째 문장, 없는 연결)는 서버가 뜰 때 도구 이름과 함께 알려 주고
멈춥니다. Postgres는 [`pg`](https://node-postgres.com) 드라이버를 쓰고, 처음 쓸 때 불러옵니다.

</details>

## 플러그인 API

모두 `@chnxthr/knowledge-mcp`에서 가져옵니다.

<details open>
<summary><code>definePlugin({...})</code></summary>
<br>

| 항목 | 형식 | 뜻 |
| --- | --- | --- |
| `id` | `string` | 영문 소문자, 숫자, 대시. 권한 그룹이자 설정 키입니다 |
| `description` | `string` | `knowledge-mcp doctor`에 나오는 한 줄 설명 |
| `env` | `string[]` | 플러그인을 켜는 데 모두 필요한 환경변수 |
| `enabled` | `() => true \| string` | 추가 조건. 꺼 둘 이유를 문자열로 돌려주면 `doctor`에 그대로 나옵니다 |
| `tools` | `Tool[]` | `defineTool`로 만든 도구 |
| `upstreams` | `UpstreamSpec[]` 또는 함수 | 이 플러그인 그룹에 넣을 원격 MCP 서버([원격 MCP 서버](#원격-mcp-서버) 참고) |
| `instructions` | `string` | 클라이언트가 연결할 때 받는 사용 안내에 덧붙일 글 |
| `configSchema` | zod 스키마 | `mcp.config.json`의 `plugins.<id>`를 검증합니다. 결과가 `ctx.config`입니다 |
| `start` | `(ctx) => void` | HTTP 서버가 뜬 뒤 한 번 실행합니다. 백그라운드 작업용입니다. stdio에서는 실행하지 않습니다 |
| `commands` | `{ [이름]: { description, run(args) } }` | 명령줄 명령: `knowledge-mcp <id> <이름> [인자]` |

</details>

<details open>
<summary><code>defineTool({...})</code>과 ctx</summary>
<br>

| 항목 | 형식 | 뜻 |
| --- | --- | --- |
| `name` | `string` | 영문 소문자, 숫자, 밑줄. 모든 플러그인을 통틀어 겹치면 안 됩니다. `ping`은 예약어입니다 |
| `description` | `string` | 무엇을 하고 언제 쓰는지. 모델이 이 글을 보고 도구를 고릅니다 |
| `input` | zod 객체 | 입력 항목. 항목마다 `.describe()`로 설명을 붙입니다. 입력이 없으면 생략합니다 |
| `annotations` | `ToolAnnotations` | `readOnlyHint`, `destructiveHint` 같은 MCP 힌트 |
| `enabled` | `() => true \| string` | 이 도구 하나에만 거는 조건 |
| `run` | `(input, ctx) => 값` | 검증된 입력과 아래 ctx를 받습니다 |

| `ctx.` | 뜻 |
| --- | --- |
| `user` | `{ email, role, keyId }`. 역할은 `admin`, `member`, `viewer` 중 하나입니다 |
| `state` | `get(key)`, `set(key, value)`, `delete(key)`. 플러그인별로 저장소에 남아 재시작해도 유지됩니다 |
| `config` | `mcp.config.json`의 `plugins.<id>` 부분 |
| `log(...)` | 플러그인 이름을 붙여 stderr에 씁니다. 비밀값은 가려집니다. stdio에서는 `console.log`를 쓰지 않습니다 |
| `signal` | 클라이언트가 호출을 취소하면 중단 신호가 옵니다. 오래 걸리는 도구는 그때 일을 멈춥니다. MCP 호출 밖에서는 없습니다 |
| `progress(done, message?)` | 오래 걸리는 호출이 얼마나 갔는지 클라이언트에 알립니다. 클라이언트가 요청했을 때만 보내고, 아니면 아무것도 하지 않습니다 |
| `auth` | 전체 인증 정보. Slack 채널과 Drive 폴더 제한도 들어 있습니다 |

</details>

<details>
<summary><code>server.ts</code>와 플러그인 불러오기</summary>
<br>

만든 프로젝트에는 시작 파일이 하나 있습니다. 이 파일이 명령줄 역할도 해서, 모든 명령이 내 플러그인을 압니다.

```ts
import { run, builtinPlugins, loadPlugins } from '@chnxthr/knowledge-mcp';

const mine = await loadPlugins(new URL('./plugins/', import.meta.url));
await run({ plugins: [...builtinPlugins, ...mine] });
```

`loadPlugins`는 폴더 안의 `.ts`, `.js` 파일을 이름 순서로 불러옵니다. `_`로 시작하는 파일, `.d.ts`, 시험 파일은
건너뜁니다. 기본 연결을 빼려면 `builtinPlugins`를 빼거나, `knowledgePlugin`, `drivePlugin`, `slackPlugin`, `githubPlugin`,
`railwayPlugin` 중 필요한 것만 넣습니다.

</details>

## 명령줄

`knowledge-mcp` 명령, Docker 이미지, 직접 만든 `server.ts` 모두 같은 명령을 받습니다.

| 명령 | 하는 일 |
| --- | --- |
| `setup` | 안내형 설정. Drive, Slack, GitHub, Railway를 연결하고, 값마다 바로 확인하고, `.env`와 설정 파일을 쓰고, 관리자 키를 만듭니다. gcloud가 있으면 Drive 서비스 계정을 대신 만들고, gh에 로그인돼 있으면 그 로그인을 쓸 수 있습니다. 다시 실행해도 안전합니다 |
| `setup check` | 설정된 서비스마다 실제로 붙어 확인합니다. 실패가 있으면 종료 코드 1 |
| `setup drive --gcloud [--project ID] [--yes]` | gcloud로 Drive 서비스 계정과 키를 만듭니다. 계획을 먼저 보여 주고, `--yes` 없이는 아무것도 만들지 않습니다 |
| `setup trust <이메일 또는 도메인>...` | 공유된 Drive 문서를 보여 줄 소유자를 추가합니다 |
| `setup folder <경로>` | 로컬 문서 폴더를 검색 색인에 넣습니다 |
| `setup connection <이름> --postgres --env NAME` / `--sqlite <파일>` / `--http <기본 URL>` | 설정에 적은 도구가 쓸 데이터베이스나 API를 추가합니다([내 데이터를 도구로](#내-데이터를-도구로)) |
| `setup secret <ENV_NAME>` | 비밀값 하나를 화면에 보이지 않게 `.env`에 넣습니다 |
| `setup drive --key <file>` / `setup github --from-gh` / `setup embeddings --base-url URL --model NAME` | 질문 없이 도는 설정 단계. 스크립트와 AI 에이전트용입니다 |
| `serve` | `$PORT`(기본 8080)에서 HTTP 서버를 띄웁니다. 터미널에서 띄우면 `/console/`에서 [콘솔](#콘솔)도 제공하고, 콘솔이 변경을 저장하면 스스로 다시 시작합니다. `--open`을 붙이거나 명령 없이 실행하면 브라우저에서 콘솔을 엽니다. `serve --stdio`는 표준 입출력으로 대화합니다 |
| `keys create [--email E] [--role R] [--label L] [--expires 90d]` | API 키를 만들고 한 번만 보여 줍니다. 해시만 저장합니다 |
| `keys list` / `keys revoke <id>` | 키 목록을 봅니다(키 값은 나오지 않음). 또는 키 하나를 끕니다 |
| `users add <email> [--role admin\|member] [--tools a,b]` | 사람을 등록합니다. `--tools`를 주면 멤버는 그 플러그인만 씁니다 |
| `users list` / `users remove <email>` | 등록된 사람을 보거나 지웁니다 |
| `doctor` | 설정 위치, 저장소, OAuth, 플러그인별 켜짐 여부와 꺼진 이유 |
| `<플러그인> <명령>` | 플러그인 명령. 예: `drive reindex --dry-run`, `slack channels` |

## 기본 플러그인

환경변수가 채워지면 켜집니다. 기본 도구는 모두 읽기만 합니다.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/ko/plugins-dark.svg">
  <img alt="기본 플러그인: 지식 검색, Google Drive, Slack, GitHub, Railway" src=".github/assets/ko/plugins-light.svg" width="100%">
</picture>

<details>
<summary>플러그인별 도구와 필요한 것</summary>
<br>

| 플러그인 | 도구 | 필요한 것 |
| --- | --- | --- |
| `knowledge` | `search_knowledge`, `read_document`, `linked_documents`, `find_documents` | 로컬 폴더(설정의 `folders`)나 Google Drive 가운데 하나. 그 밖에는 필요 없습니다. 색인은 로컬 파일이고 키워드로 검색합니다. 임베딩 모델(`OPENAI_API_KEY`, 또는 `EMBEDDING_BASE_URL`로 다른 제공자)을 넣으면 뜻으로도 찾습니다. `QDRANT_URL`을 정하면 벡터를 Qdrant에 두고, 그때는 임베딩 모델이 꼭 있어야 합니다. `find_documents`는 언어 모델을 연결했을 때 보입니다 |
| `drive` | `search_drive`, `read_drive_file`, `list_drive_folder` | 콘솔에서 한 구글 로그인(본인 Drive를 읽습니다)이나 Google 서비스 계정. 서비스 계정은 폴더나 문서를 그 계정에 공유하면 검색됩니다. 환경변수의 OAuth refresh token도 됩니다 |
| `slack` | `slack_list_channels`, `slack_read_channel`, `slack_find_files`, `slack_get_file` | `SLACK_BOT_TOKEN`(`xoxb-`). 봇은 초대받은 채널만 봅니다 |
| `slack` | `slack_search` | `SLACK_USER_TOKEN`(`xoxp-`)도 필요합니다. 결과는 봇이 들어간 채널로 거릅니다 |
| `github` | `repo_tree`, GitHub 원격 MCP 도구 `github_*`(읽기 전용) | Contents 읽기 권한이 있는 `GITHUB_PAT`(또는 `GITHUB_TOKEN`) |
| `railway` | `railway_services`, `railway_deployments`, `railway_logs`(로그 속 비밀값은 가림) | 콘솔에서 한 로그인이나 `RAILWAY_TOKEN`. 로그인은 뷰어 권한만 요청합니다. 프로젝트와 배포 상태는 읽고, 로그는 Railway가 보여 주지 않습니다. 로그는 토큰이 있어야 합니다 |
| 코어 | `ping` | 없음. 내가 누구로 접속했는지, 어떤 플러그인이 켜졌는지 보여 줍니다 |

</details>

<details>
<summary>검색 색인</summary>
<br>

`search_knowledge`는 모든 출처가 채우는 색인 하나를 검색합니다. 출처만 있으면 됩니다.

| 검색 방식 | 언제 | 무엇을 찾나 |
| --- | --- | --- |
| 키워드 | 항상. 아무것도 설정하지 않아도 됩니다 | 질문에 든 낱말이 들어 있는 문서. 한글, 일본어, 중국어는 두 글자씩 잘라 맞추므로 조사가 붙어도 찾습니다 |
| 키워드와 뜻 | 임베딩 모델을 정했을 때(`OPENAI_API_KEY`, 또는 `EMBEDDING_BASE_URL`로 다른 제공자나 로컬 모델) | 같은 내용을 다른 말로 쓴 문서도 찾습니다. 두 결과를 순위로 합칩니다. 임베딩 주소가 죽으면 키워드로 답하고 그 사실을 알립니다 |
| 뜻만 | `QDRANT_URL`을 정했을 때 | 벡터를 Qdrant에 둡니다. 여기에는 키워드 색인이 없어 임베딩 모델이 꼭 있어야 합니다 |

모델이 읽는 응답은 짧게 유지합니다. 모델은 읽는 만큼 비용을 냅니다.

| 도구 | 돌려주는 것 |
| --- | --- |
| `search_knowledge` | 조각을 `topK`개까지(기본 5, 문서마다 최대 2) 돌려줍니다. 조각마다 문서, 날짜, ID, 제목 경로, 질문의 낱말 가운데 몇 개가 들어 있는지를 붙입니다. 한 문서에서 이웃한 두 조각은 한 덩어리로 보여 줍니다. 질문 낱말의 절반도 든 조각이 없으면 일치가 약하다고 알립니다. 필터에 맞는 것이 없으면 그 항목이 가진 값을 알려 줍니다 |
| `read_document` | `part`(검색 결과에 나온 번호)를 주면 그 조각과 앞뒤 조각을 돌려줍니다(`around`, 기본 1). 수천 자 정도입니다. 주지 않으면 문서를 처음부터 `maxChars`(기본 20,000)까지 돌려주고, 이어 읽을 `offset`을 알려 줍니다. JSON이 아니라 일반 글입니다 |
| `linked_documents` | 문서 ID를 주면 그 문서가 가리키는 문서와 그 문서를 가리키는 문서를 제목과 ID로 돌려줍니다. 주지 않으면 문서 수와 링크 수, 가장 많이 가리켜지는 문서를 돌려줍니다. 연결이 있는 검색 결과에는 `Links: to 2 · from 3`이 붙습니다 |
| `find_documents` | 검색 도우미가 찾은, 질문에 답이 든 문서. `limit`개까지(기본 8) 순서대로 돌려주고, 문서마다 ID, 먼저 읽을 부분, 무엇이 들었는지 한 줄을 붙입니다. 본문 조각은 주지 않습니다. 물어본 모델이 `read_document`로 필요한 만큼 읽습니다 |
| 데이터베이스 도구 | 행을 압축한 표로 돌려줍니다. `{"rowCount":2,"columns":["id","total"],"rows":[[1,10.5],[2,20]]}` 모양이고 한 줄에 한 행입니다. 열 이름은 한 번만 씁니다 |

**지식 그래프.** 로컬 폴더의 문서는 작성자가 적은 링크 그대로 연결됩니다. 모델을 거치지 않습니다. 옵시디언이
쓰는 `[[노트]]`, `[[노트|보이는 글]]`, `[[폴더/노트#제목]]`, 문서를 가리키는 Markdown 링크
(`[가이드](../guides/setup.md)`), 문서를 적은 머리말 항목(`related: [a.md, "[[노트]]"]`)을 읽습니다. 그래서
옵시디언 볼트를 폴더로 추가하면 그래프도 함께 들어옵니다. 링크는 경로, 폴더 안의 파일 이름, 제목과 별칭으로
문서를 찾습니다. 나중에 쓴 노트가 어제의 끊긴 링크를 잇습니다. 문서를 가리킨 것이 분명한데 맞는 문서가 없을
때만 깨진 링크로 알립니다.

| 작업 | 방법 |
| --- | --- |
| 로컬 폴더 추가 | `knowledge-mcp setup folder <경로>` 또는 설정의 `folders`. HTTP 서버는 뜰 때, 10분마다(`KNOWLEDGE_SCAN_INTERVAL_MIN`), 그리고 폴더 안 파일을 저장하거나 더하거나 지우면 몇 초 뒤에 훑습니다(폴더를 지켜봅니다. `KNOWLEDGE_WATCH=false`로 끕니다). stdio 세션은 시작할 때 한 번 훑습니다. `knowledge-mcp knowledge scan`은 지금 훑습니다. 바뀌지 않은 파일은 열지 않고, 지운 파일은 색인에서 빠집니다. 글을 먼저 색인하고 벡터는 뒤에 만들어서, 키워드 검색은 몇 초 안에 폴더 전체를 찾습니다. 임베딩 모델이 꺼져 있거나 느려서 만들지 못한 벡터는 1분, 5분, 15분 뒤에 다시 만들고, 콘솔에 이유를 보여 줍니다. 이 컴퓨터의 모델에는 한 번에 32개씩, 시간 제한 120초로 보냅니다(`EMBED_BATCH`, `EMBED_TIMEOUT_MS`) |
| Drive 문서 추가 | Drive를 연결합니다. 색인이 빈 채로 서버가 뜨면 처음 색인을 스스로 만들고(`DRIVE_AUTO_INDEX=false`로 끕니다), 그 뒤 30분마다 변경분을 반영합니다(`DRIVE_SYNC_INTERVAL_MIN`). stdio 세션은 시작할 때 한 번 반영합니다 |
| 뜻 검색을 나중에 추가 | 임베딩 모델을 정하고 서버를 다시 띄웁니다. 저장된 조각은 다음 훑기나 동기화 때 벡터를 받습니다. 문서를 다시 읽지 않습니다 |
| 임베딩 모델 바꾸기 | 새 모델을 정한 뒤 `knowledge-mcp knowledge reembed`를 실행합니다. 옛 벡터를 버리고 저장된 글로 새 벡터를 만듭니다. 그 전까지는 키워드로 답합니다. 두 모델의 벡터는 섞지 않습니다 |
| 밖으로 나가는 것 | 키워드 검색은 아무것도 내보내지 않습니다. 임베딩 모델을 정하면 조각 글과 질문이 그 모델의 주소로 갑니다 |
| 저장 위치 | `<데이터 폴더>/vectors.db`: 글, 키워드 색인, 벡터가 들어 있습니다. 조각 9만 개(파일 5천 개)로 잰 값은 키워드 검색 약 6ms, 뜻 검색 약 85ms입니다. 벡터는 조각마다 4바이트 × 차원 수만큼 메모리를 씁니다(1,024차원이면 370MB). 뜻 검색을 처음 할 때 읽습니다. 더 큰 색인이나 서버 여러 대는 `QDRANT_URL`을 정하고 다시 색인합니다 |
| 스캔 파일 | 폴더 훑기는 스캔을 직접 읽지 않고 개수만 셉니다. 읽기는 따로 실행합니다. 콘솔의 Documents → Scanned files에서 시작하고, 이 컴퓨터의 OCR이면 훑을 때마다 이어서 읽도록 켤 수 있습니다. 읽은 글은 보관해서, 파일이 바뀌지 않는 한 다시 읽지 않습니다. OCR이 설정돼 있으면 `knowledge-mcp drive reindex`가 Drive의 스캔 파일도 읽습니다(`--no-ocr`는 뺍니다) |
| 정리 | `drive reindex` 전체 실행은 목록에서 빠진 Drive 문서를 지웁니다. 제외 폴더로 옮긴 파일이 여기에 해당합니다 |
| 처음부터 다시 | `drive reindex --recreate`는 색인을 비우고 시작합니다. 로컬 폴더 문서도 비워지고, 다음 훑기 때 다시 색인됩니다. `--dry-run`은 조각 수만 세고 OCR을 건너뜁니다 |

잠금 파일이 같은 데이터 폴더를 쓰는 두 프로세스의 동시 색인을 막습니다.

| 형식 | 글을 뽑는 방법 |
| --- | --- |
| Markdown, 일반 텍스트 | 그대로 |
| Google 문서, 슬라이드 | Drive 내보내기 |
| Google 스프레드시트 | Drive에서 내보내 탭마다 한 절로 읽습니다 |
| Word, PowerPoint, Excel, 글자가 든 PDF | 서버 안의 파서 |
| 스캔 PDF, PNG, JPEG, WebP | OCR을 설정했을 때. 쪽마다 그림으로 그려 이미지를 읽는 모델에게 보냅니다(이 컴퓨터의 Ollama, Hugging Face Inference Providers, 이미지를 받는 OpenAI 호환 주소). Mathpix도 됩니다. 로컬 폴더의 이미지는 OCR이 설정됐을 때만 목록에 넣습니다 |

**스캔 문서 읽기(OCR).** 콘솔의 Documents → Scanned files에서 무엇으로 읽을지 고릅니다.

| 선택 | 내용 |
| --- | --- |
| This computer | Ollama의 이미지 읽는 모델. 모델은 콘솔이 받아 옵니다. 쪽이 컴퓨터 밖으로 나가지 않고 요금도 없습니다 |
| Hugging Face | 토큰으로 쓰는 Inference Providers(`https://router.huggingface.co/v1`). 쪽이 Hugging Face와 모델을 돌리는 협력사로 갑니다 |
| Another endpoint | 이미지를 받는 OpenAI 호환 chat completions 주소. OpenRouter, vLLM, LM Studio |
| Mathpix | 전과 같습니다. `MATHPIX_APP_ID`, `MATHPIX_APP_KEY` |

모델은 저장하기 전에 시험 쪽을 읽어 내야 합니다. 설정 이름은 `OCR_PROVIDER`(`model` 또는 `mathpix`), `OCR_BASE_URL`,
`OCR_API_KEY`, `OCR_MODEL`, `OCR_PROMPT`입니다. glm-ocr와 deepseek-ocr는 모델 카드에 적힌 요청을 씁니다. 파일 하나에서
읽는 쪽은 `OCR_MAX_PAGES`(200)까지입니다. 글자를 아는 한국어 PDF 16쪽을 Apple Silicon Mac의 Ollama로 읽혀 잰 값은
다음과 같습니다.

| 모델 | 틀린 글자(쪽마다 중앙값) | 쪽마다 초 |
| --- | --- | --- |
| `qwen3-vl:8b-instruct` | 100자에 1자 정도 | 15 |
| `glm-ocr:q8_0` | 10자에 1자 정도 | 6 |
| `deepseek-ocr:3b` | 100자에 4자 정도. 다만 16쪽 중 5쪽은 한 구절을 끝없이 되풀이했습니다 | 8 |


`DRIVE_MAX_FILE_BYTES`(기본 50MB)보다 큰 파일은 읽거나 색인하지 않습니다. 로컬 폴더에서는 점으로 시작하는 파일,
`node_modules`, `drive.excludeFolders`에 적은 폴더 이름, 심볼릭 링크를 건너뛰고, 폴더마다 2만 개까지 색인합니다
(`KNOWLEDGE_MAX_FILES`). 임베딩은 OpenAI `text-embedding-3-small`을 기본으로 씁니다. OpenAI 호환 `/embeddings`
주소라면 무엇이든 쓸 수 있습니다. `EMBEDDING_BASE_URL`, `EMBEDDING_MODEL`, `EMBEDDING_DIM`을 정하십시오(예: Ollama 뒤의
로컬 `bge-m3`).

**조각을 만드는 방식.** 문서를 어떻게 자르느냐에 따라 검색이 찾는 것이 달라집니다. 어느 방식이 나은지는 문서마다
다릅니다. 콘솔의 Documents → Passages에서 고르고, 고르기 전에 내 문서로 방식을 비교할 수 있습니다. 설정 파일에서는
`knowledge.index`입니다.

| 설정 | 값 | 기본 |
| --- | --- | --- |
| `cut` | `sections`: 제목에서 자르고, 절이 길면 문단에서 자릅니다. `windows`: 제목을 무시하고 길이로 자릅니다 | `sections` |
| `maxTokens` | 조각 하나의 최대 토큰. 100~4,000 | 800 |
| `overlapTokens` | 앞 조각에서 되풀이할 토큰 | 조각의 8분의 1, 최대 100 |
| `header` | 임베딩 모델이 조각과 함께 읽는 것. `heading`(제목 경로), `document`(문서 이름과 제목 경로), `none` | `heading` |
| `queryPrefix`, `passagePrefix` | 질문 앞, 조각 앞에 붙이는 말 | 아는 모델이면 그 모델의 것 |

환경 변수가 설정 파일보다 먼저입니다. `KNOWLEDGE_CHUNK_CUT`, `KNOWLEDGE_CHUNK_TOKENS`, `KNOWLEDGE_CHUNK_OVERLAP`,
`KNOWLEDGE_EMBED_HEADER`, `EMBEDDING_QUERY_PREFIX`, `EMBEDDING_PASSAGE_PREFIX`입니다. 임베딩 모델이 학습한 접두어는
모델 이름으로 알아봅니다. qwen3-embedding, e5, nomic-embed-text, embeddinggemma, mxbai-embed-large, bge-*-en이
대상이고, 값은 각 모델 카드를 따릅니다. 그 밖의 모델은 직접 정하지 않으면 붙이지 않습니다. Qdrant를 쓸 때는 조각
앞 접두어를 스스로 붙이지 않습니다.

| 바꾼 것 | 일어나는 일 |
| --- | --- |
| `cut`, `maxTokens`, `overlapTokens` | 로컬 폴더 문서는 다음 훑기 때 새로 자릅니다. 콘솔에서 저장하면 바로 시작합니다. Drive 문서는 바뀔 때, 또는 `drive reindex`로 한 번에 자릅니다 |
| `header`, 조각 앞 접두어 | 모든 조각의 벡터를 새로 만들어야 합니다. 콘솔의 Make new vectors나 `knowledge reembed`를 씁니다. 그 전까지는 새 조각과 질문도 저장된 벡터와 같은 방식으로 임베딩합니다. 두 방식은 섞지 않습니다 |

| 명령 | 하는 일 |
| --- | --- |
| `knowledge-mcp knowledge measure` | 정답 문서가 정해진 질문을 지금 색인에 묻고, 키워드, 뜻, 둘 다로 정답이 몇 위에 나오는지 셉니다 |
| `knowledge-mcp knowledge compare` | 로컬 폴더 문서를 200개까지 방식마다 잘라 메모리에서 임베딩하고, 같은 질문을 뜻으로 묻습니다. 색인은 바꾸지 않습니다 |

질문은 Agent 화면에 연결한 모델이 문서 40개에서 하나씩 씁니다. 쓴 질문은 `<데이터 폴더>/search-measure.json`에
두고 매번 같은 질문을 묻기 때문에 결과를 나란히 볼 수 있습니다. 직접 쓴 질문으로 바꿔도 됩니다
(`{"questions":[{"question":"…","document":"경로의 일부"}]}`). `--new`는 질문을 새로 씁니다. Markdown 503개로 된
위키에서 `qwen3-embedding:0.6b`와 질문 84개로 잰 값은 다음과 같습니다. 제목 단위 250~800토큰은 비슷했습니다(정답이
3위 안에 든 질문 71~75개). 길이로 자르면 덜 찾았습니다. 모델의 접두어를 질문 앞에 붙이면 정답이 1위인 질문이
43개에서 48개로 늘었습니다.

</details>

<details>
<summary>Slack 채널 용도표</summary>
<br>

`slack_list_channels`는 채널마다 무슨 용도인지 모델에게 알려 줍니다.

1. 읽을 채널에 봇을 초대하고, 클라이언트에서 `slack_list_channels`를 한 번 부릅니다. 이때 Slack 채널 목록이
   용도표로 복사됩니다. 새 채널은 꺼진 채로 들어옵니다.
2. `knowledge-mcp slack channel '#dev' --purpose "배포와 장애" --on`으로 용도를 적고 켭니다.
   용도표는 `knowledge-mcp slack channels`로 봅니다.

켜고 끄기는 `slack_list_channels`가 기본으로 보여 줄 채널만 정합니다. 읽기 권한은 바꾸지 않습니다.
읽을 수 있는지는 봇이 들어간 채널과 사람마다 허용한 채널로 정해집니다.

</details>

## 설정

| 층 | 위치 | 내용 |
| --- | --- | --- |
| 비⁠밀⁠값 | 환경변수(로컬은 `.env`, 운영은 호스트 환경변수) | 키와 토큰. [`.env.example`](.env.example)에 모두 있습니다 |
| 볼⁠ ⁠대⁠상 | `mcp.config.json` | Drive 폴더, 제외 폴더, 로그인 허용 목록, viewer 권한, 플러그인 설정, 원격 MCP 서버. [`mcp.config.example.json`](mcp.config.example.json) 참고 |

`.env`와 `mcp.config.json`은 현재 폴더를 먼저 보고, 없으면 프로젝트 폴더를 봅니다. 클라이언트가 다른 폴더에서
서버를 띄워도 찾습니다. `MCP_CONFIG_JSON`(내용 직접)과 `MCP_CONFIG_PATH`가 있으면 그쪽이 먼저입니다.
`MCP_HOME`은 설정과 데이터가 있는 폴더를 직접 정합니다. 이때 현재 폴더는 보지 않습니다. npx로 서버를 띄우는
클라이언트 설정에 필요합니다(클라이언트가 실행되는 폴더는 남의 프로젝트이기 때문입니다).
설정은 시작할 때 한 번 읽습니다. 로그인 허용 목록을 포함해 설정을 바꾸면 서버를 다시 시작합니다.
(터미널에서 띄운 서버는 콘솔이 변경을 저장하면 스스로 다시 시작합니다.)

| 설정 키 | 뜻 |
| --- | --- |
| `orgId` | 인증 정보에 실리는 조직 식별자 |
| `branding.name` / `branding.instructions` | 로그인 동의 화면과 OAuth 메타데이터에 보이는 이름. `instructions`를 적으면 클라이언트가 받는 안내(기본 문장과 플러그인별 안내)를 대신합니다 |
| `folders[]` | 색인하고 검색할 로컬 폴더 `{ path, name, source }`. `path`는 절대 경로이거나 설정 파일 기준 상대 경로입니다. `name`(기본: 폴더 이름)은 결과와 문서 id에 보입니다. `source`(기본 `files`)는 검색의 `source` 필터 이름입니다. 환경변수 `KNOWLEDGE_FOLDERS`에 쉼표로 나눈 경로를 더 적을 수 있습니다 |
| `drive.roots[]` | 색인하고 검색할 폴더 `{ id, name, source, metadata }`. `source`는 직접 정하는 이름입니다(`handbook`, `sales` 등, 기본 `docs`). 검색의 `source` 필터가 됩니다. `metadata`는 `path`(기본. 폴더와 파일 이름에서 분류, 고객사, 태그를 얻음) 또는 `frontmatter`(YAML 머리말이 있는 Markdown)입니다 |
| `drive.scope` | `shared`(기본): root와, 신뢰하는 소유자(`drive.trustedOwners`)가 서비스 계정에 따로 공유한 폴더나 문서가 범위입니다. `roots`: `drive.roots` 아래 파일만 봅니다. env `DRIVE_SCOPE`가 우선합니다 |
| `drive.trustedOwners[]` | root 밖에서 서비스 계정에 공유된 문서 가운데 누구의 문서를 보여 줄지 정합니다. 이메일(`ann@acme.com`), 도메인(`acme.com`), 공유 드라이브(`drive:<id>`)를 적습니다. 기본은 빈 목록이고, 그때는 root 밖 문서를 보여 주지 않습니다. `knowledge-mcp setup`이 물어봅니다. env `DRIVE_TRUSTED_OWNERS`가 우선합니다 |
| `drive.sharedSource` | root 밖 공유 문서에 붙는 `source` 이름. 기본 `shared` |
| `drive.excludeFolders[]` | Drive와 로컬 폴더 모두에서, 색인, 검색, 읽기, 목록 어디서든 건너뛸 폴더 이름. 대소문자와 공백은 무시합니다 |
| `drive.customerFolders[]` | 고객사마다 하위 폴더를 둔 최상위 폴더(`path` 메타 출처에서)(`Clients/Acme/…` → 고객사 `Acme`). 검색의 `customer` 필터에 씁니다. 기본 `Clients`, `Customers`, `고객사` |
| `drive.rank[]` | `search_knowledge`의 선택 규칙 `{ prefix, label, weight }`. 예: `Current/`(가중치 1.1)를 `Archive/`(0.9)보다 앞에. 기본은 없음 |
| `qdrant.collection` | 벡터 컬렉션 이름(환경변수 `QDRANT_COLLECTION`이 먼저) |
| `oauth.allowedDomains[]` / `oauth.allowedEmails[]` | Google 로그인을 허용할 대상 |
| `access.viewerTools[]` | 등록되지 않은 로그인 사용자에게 열 플러그인 id. 기본은 없음 |
| `plugins.<id>` | 플러그인 하나의 설정. `ctx.config`로 들어갑니다 |
| `upstreams[]` | 원격 MCP 서버(다음 절) |
| `connections.<이름>` | Postgres 데이터베이스, SQLite 파일, HTTP API. 이름이 권한 그룹입니다. [내 데이터를 도구로](#내-데이터를-도구로) 참고 |
| `tools[]` | 연결 위에 적는 도구. 하나가 SQL 질의 하나 또는 API 요청 하나이고, 매개변수에 형식이 있습니다 |
| `data.schema` | 서버 표를 둘 Supabase 스키마(Supabase 저장소일 때만) |

<details>
<summary>저장소: SQLite 또는 Supabase</summary>
<br>

| 저장소 | 언제 | 준비 |
| --- | --- | --- |
| SQLite(기본) | 서버 하나, 기계 하나 | 없음. 파일은 `<데이터 폴더>/knowledge-mcp.db`입니다(`MCP_DATA_DIR`, Docker는 `/data`). 소유자만 읽게 만듭니다(0600) |
| Supabase | 상태를 공용 Postgres에 두고 화면으로 보고 싶을 때 | [`sql/supabase.sql`](packages/knowledge-mcp/sql/supabase.sql)을 실행하고(업그레이드마다 다시), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`를 넣습니다 |

Supabase 변수 두 개가 다 있으면 Supabase를 씁니다. `MCP_STORE=sqlite|supabase`로 정할 수도 있습니다.

</details>

### 원격 MCP 서버

서버는 게이트웨이도 됩니다. 다른 MCP 서버를 적으면 그 도구가 접두어를 달고 나타나고, 내 키와 권한 뒤에 놓입니다.

콘솔에서는 **Apps → Add an app**입니다. 목록(Notion, Supabase, Linear, Atlassian, Sentry, Vercel, Stripe, Airtable,
Figma 등)에서 고르거나 MCP 서버 주소를 직접 넣습니다. 서버가 로그인할 곳을 알려 주고 클라이언트의 자동 등록을
받으면 그곳으로 보내 로그인하게 합니다. 서비스가 토큰을 주면 토큰을 붙여 넣어도 됩니다. 직접 적을 때는
`mcp.config.json`에 이렇게 씁니다.

```json
{
  "upstreams": [
    {
      "name": "notion",
      "url": "https://mcp.example.com/mcp",
      "tokenEnv": "NOTION_MCP_TOKEN",
      "expose": "read"
    }
  ]
}
```

| 항목 | 뜻 |
| --- | --- |
| `name` | 권한 그룹이자 로그에 쓰는 이름 |
| `prefix` | 도구 이름 접두어. 기본 `<name>_` |
| `tokenEnv` | bearer 토큰이 든 환경변수 이름. 토큰 자체는 설정 파일에 넣지 않습니다 |
| `signIn` | `true`면 콘솔에서 한 로그인을 씁니다(`<데이터 폴더>/mcp-logins/<name>.json`). 게이트웨이가 스스로 갱신합니다. `tokenEnv`와 함께 쓰지 않습니다 |
| `expose` | `"read"`(기본)는 읽는 도구만 엽니다. 원격 서버가 읽기 전용이라고 표시한 도구를 열고, 표시가 없는 도구는 첫 단어가 `get`, `list`, `search` 같은 읽기 동사일 때 엽니다(`notion-search`는 `search`로 봅니다). 원격 서버가 바꾸는 도구라고 표시하면 이름과 상관없이 숨깁니다. `"all"`은 전부 엽니다. 목록을 주면 그 이름만 엽니다 |

원격 도구와 이름이 같은 로컬 도구가 있으면 로컬 도구가 이기고 원격 도구는 숨깁니다.

## 접근 권한

**누구인지**는 API 키나 Google 로그인으로 정합니다. **무엇을 쓸 수 있는지**는 사용자 등록 정보로 정합니다.

| 등록 정보 | 역할 | 쓸 수 있는 것 |
| --- | --- | --- |
| `--role admin` | admin | 모든 도구 |
| `--role member` | member | 모든 플러그인. `--tools`를 주면 그 플러그인만 씁니다. Drive 폴더와 Slack 채널도 제한할 수 있습니다 |
| 등록 안 됨 | viewer | `ping`, 그리고 `access.viewerTools`에 적은 플러그인만 |

```bash
knowledge-mcp users add lee@example.com --role member --tools drive,notes
knowledge-mcp keys create --email lee@example.com --expires 90d
```

<details>
<summary>API 키</summary>
<br>

1. 키는 `kmcp_…` 모양이고 SHA-256 해시로만 저장합니다. 키는 만들 때 한 번만 보여 줍니다.
2. 이메일이 붙은 키는 그 사람의 등록 정보에서 역할을 가져옵니다. 등록을 지우면 키 권한도 내려갑니다.
   이메일이 없는 키는 자기 역할을 가진 서비스 키입니다.
3. `keys revoke <id>`는 `AUTH_CACHE_TTL_MS`(기본 60초) 안에 반영됩니다.
4. 인증 실패는 클라이언트 IP마다 횟수를 제한합니다. 실제 IP를 보려면 프록시 구성에 맞게 `TRUST_PROXY`를 정합니다.
5. stdio는 `MCP_API_KEY`가 없으면 로컬 관리자로 돕니다. 프로세스를 띄운 사람이 이미 모든 토큰을 쥐고 있기 때문입니다.

</details>

<details>
<summary>Claude 웹, 데스크톱 커넥터용 OAuth</summary>
<br>

OAuth 환경변수와 허용 목록을 넣으면 Google로 로그인하는 OAuth 2.1 서버가 켜집니다. 토큰을 내주기 전에
어떤 앱이 어디로 토큰을 받는지 동의 화면으로 보여 줍니다. 자세한 안내는 [`OAUTH_SETUP.md`](OAUTH_SETUP.md)에 있습니다.

</details>

## 배포

| 대상 | 방법 |
| --- | --- |
| 기본 연결 | `ghcr.io/chanthr/knowledge-mcp`(`latest`는 최신 릴리스, `x.y.z`, `edge`는 `main`). [`compose.yaml`](compose.yaml)이 데이터 볼륨과 함께 띄웁니다 |
| 직⁠접⁠ ⁠만⁠든⁠ ⁠프⁠로⁠젝⁠트 | 만들어진 `Dockerfile`로 `docker build` 하고 `/data`에 볼륨을 붙여 실행합니다 |
| Railway | [`railway.toml`](railway.toml). `/data`에 볼륨을 붙이거나 `MCP_STORE=supabase`를 씁니다 |

1. **HTTPS.** 원격 클라이언트를 붙이기 전에 HTTPS 뒤에 둡니다. OAuth 발급자는 `https`여야 합니다.
2. **인스턴스 하나.** 세션과 진행 중인 로그인은 메모리에 있고, SQLite는 파일 하나입니다. 한 대만 띄웁니다.
3. **`/data` 유지.** 볼륨이 없으면 재배포 때 키와 사용자가 사라집니다.

### 내 컴퓨터에서 공개 주소 만들기

밖에서 접속하게 하려고 서버를 다른 곳으로 옮기지 않아도 됩니다. 콘솔의 **Connect a client → Other people**에서 [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)로 https 주소를 붙입니다. Cloudflare의 프로그램 cloudflared가 내 컴퓨터에서 바깥으로 연결하므로, 공유기에서 열 것도 없고 인증서를 만들 것도 없습니다.

| | 임시 주소 | 내 주소 |
| --- | --- | --- |
| 모양 | `https://<낱말>.trycloudflare.com` | `https://mcp.example.com` |
| 필요한 것 | 없음 | Cloudflare 계정에 있는 도메인. 콘솔이 주소를 먼저 확인한 뒤 `cloudflared tunnel login`을 실행합니다. 브라우저가 열리면 그 도메인을 고릅니다 |
| 유지 | 끌 때까지. 켤 때마다 새 주소 | 주소가 그대로이고, 서버를 다시 띄우면 함께 돌아옵니다 |
| 용도 | 시험. Cloudflare가 보장하지 않고, 오래 열어 두는 스트림은 지나가지 않습니다 | 다른 사람, 웹의 Claude, ChatGPT |

Homebrew나 winget이 있으면 콘솔이 cloudflared를 설치하고, 터널과 DNS 레코드를 만들고, 터널을 시작합니다. 계정에
무엇이든 만들기 전에 주소부터 확인합니다. 그 도메인이 Cloudflare에 있어야 하고(공개 DNS로 확인), 로그인이 그
도메인 것이어야 합니다(로그인에 든 토큰으로 Cloudflare API에 묻습니다. 로그인 하나는 도메인 하나용입니다).
레코드를 만든 뒤에는 cloudflared가 실제로 만든 이름을 요청한 이름과 대조하고, 밖에서 `https://<주소>/health`가
응답해야 정상으로 표시합니다. 그 이름에 이미 있는 DNS 레코드는 덮어쓰지 않습니다.

바뀌지 않는 것도 있습니다. `/mcp`는 전과 같이 키나 로그인을 요구하고, 콘솔은 내 컴퓨터에서만 응답합니다(터널로
오면 403). 사용자의 cloudflared 설정은 읽지도 쓰지도 바꾸지도 않습니다. `~/.cloudflared/config.yml`, 다른 터널,
사용자가 직접 한 `cloudflared tunnel login`의 인증서 모두 그렇습니다. 이 서버는 따로 로그인하고(cloudflared를
`HOME`을 데이터 폴더로 두고 실행), 터널의 설정 파일과 자격 증명도 거기에 둡니다. 콘솔에서 로그아웃하면 그 파일을
지웁니다. 그 안의 토큰은 Cloudflare 대시보드(My Profile, API Tokens)에서 지울 때까지 유효합니다.

## 클라이언트 연결

콘솔의 **Connect a client** 화면이 대신 해 줍니다. 클라이언트마다 버튼이 하나 있고, 내 폴더와 서버 이름에 맞춘
항목을 넣습니다. 데스크톱 앱에는 터미널의 PATH가 없습니다. 그래서 콘솔이 쓰는 항목은 Node를 전체 경로로
가리키고, 서버가 거기서도 시작됩니다.

| 클라이언트 | 방법 |
| --- | --- |
| C⁠l⁠a⁠u⁠d⁠e⁠ ⁠C⁠o⁠d⁠e⁠,⁠ ⁠로⁠컬 | `claude mcp add my-mcp -- node /절대경로/my-mcp/dist/server.js serve --stdio`(먼저 `npm run build`) |
| C⁠l⁠a⁠u⁠d⁠e⁠ ⁠C⁠o⁠d⁠e⁠,⁠ ⁠로⁠컬⁠,⁠ ⁠프⁠로⁠젝⁠트⁠ ⁠없⁠이 | `claude mcp add --scope user my-mcp -e MCP_HOME=/절대경로/폴더 -- npx -y @chnxthr/knowledge-mcp serve --stdio` |
| C⁠l⁠a⁠u⁠d⁠e⁠ ⁠D⁠e⁠s⁠k⁠t⁠o⁠p⁠,⁠ ⁠C⁠u⁠r⁠s⁠o⁠r⁠,⁠ ⁠V⁠S⁠ ⁠C⁠o⁠d⁠e | 같은 명령과 `MCP_HOME`을 클라이언트 설정 파일의 `command`, `args`, `env`에 적습니다 |
| C⁠l⁠a⁠u⁠d⁠e⁠ ⁠C⁠o⁠d⁠e⁠,⁠ ⁠원⁠격 | `claude mcp add --transport http my-mcp https://<호스트>/mcp --header "Authorization: Bearer <키>"` |
| C⁠l⁠a⁠u⁠d⁠e⁠ ⁠웹⁠,⁠ ⁠데⁠스⁠크⁠톱 | OAuth를 켜고 `https://<호스트>/mcp`로 커스텀 커넥터를 추가합니다 |
| 다⁠른⁠ ⁠M⁠C⁠P⁠ ⁠클⁠라⁠이⁠언⁠트 | 주소 `https://<호스트>/mcp`, 헤더 `Authorization: Bearer <키>` |

## 0.3에서 올리기

| 바뀐 것 | 할 일 |
| --- | --- |
| Drive 범위 기본값이 `shared` | 신뢰하는 소유자가 `drive.roots` 밖에서 서비스 계정에 공유한 문서를 검색하고, 읽고, 색인할 수 있습니다. `drive.trustedOwners`에 소유자를 넣기 전에는 달라지는 것이 없습니다(`knowledge-mcp setup trust acme.com`). 제외 폴더는 계속 숨깁니다. `drive.scope: "roots"`로 끕니다 |
| zod 4 | 플러그인이 쓰는 `z`가 zod 4가 됩니다. `z.record(값스키마)`는 `z.record(z.string(), 값스키마)`로, 안쪽 기본값에 기대는 객체의 `.default({})`는 `.prefault({})`로 고치십시오 |
| `source`가 자유 이름 | `dev`와 `biz`는 옛 뜻 그대로 동작합니다. `--dev-only`, `--biz-only`도 그대로 되고, 일반형은 `--source <이름>`입니다 |
| Google 스프레드시트를 탭마다 읽음 | 색인된 시트는 다음에 수정될 때 바뀝니다. 지금 모두 새로 하려면 `knowledge-mcp drive reindex`를 실행하십시오 |
| `semantic_search_drive`가 `search_knowledge`로 바뀜 | 모든 출처를 검색하고, 임베딩 모델 없이 키워드로 찾습니다. 권한 그룹은 `knowledge`입니다. 사람별 tools나 `access.viewerTools`에 `drive`를 적은 곳에 `knowledge`를 더하십시오. 결과의 Document ID는 `read_document`로 읽습니다 |
| 검색이 문서당 2조각까지만 보여 줌 | `KNOWLEDGE_MAX_PER_DOC`로 바꿉니다 |

## 0.2에서 올리기

| 바뀐 점 | 할 일 |
| --- | --- |
| Supabase가 선택이 되고 SQLite가 기본입니다 | `SUPABASE_*`가 있는 기존 설치는 계속 Supabase를 씁니다. [`sql/supabase.sql`](packages/knowledge-mcp/sql/supabase.sql)을 한 번 다시 실행합니다. `mcp_plugin_state` 표를 만들고 Drive 동기화 토큰을 옮깁니다 |
| 스크립트가 명령줄로 옮겨졌습니다 | `npm run reindex`는 `knowledge-mcp drive reindex`가 됩니다. 이미지 진입점은 `node dist/index.js` 대신 `knowledge-mcp`(기본 `serve`)입니다 |
| 역할 `engineer`가 `member`가 됐습니다 | 기존 값은 그대로 동작합니다. `access.viewerTools`와 `allowed_tools`에는 어떤 플러그인 id든 씁니다 |
| `MCP_API_KEY` 없는 stdio | 시작을 거부하지 않고 로컬 관리자로 돕니다 |
| 깨진 `mcp.config.json` | 기본값으로 조용히 넘어가지 않고 파싱 오류를 보여 주며 멈춥니다 |

## 보안 참고

1. `.env`, 서비스 계정 JSON, `mcp.config.json`, `data/`는 커밋하지 않습니다. 모두 gitignore와 이미지 제외 목록에 있습니다.
2. 데이터 파일에는 키 해시와 OAuth 클라이언트 비밀값이 있습니다. 소유자만 읽게 만들어지니 볼륨도 비공개로 둡니다.
3. 기본 플러그인은 Drive, Slack, GitHub, Railway를 바꾸지 않습니다. 게이트웨이는 `expose`를 바꿀 때만 원격 쓰기 도구를 엽니다. 기본 도구 가운데 쓰는 것은 `save_note` 하나이고, 이것과 `POST /inbox`는 설정 옆 `notes/`, `inbox/`에 새 Markdown 파일만 씁니다(또는 그 안의 노트를 바꿉니다). member와 admin만 쓸 수 있고 viewer는 못 씁니다.
4. Drive 색인은 임베딩을 위해 문서 본문을 임베딩 제공자로 보냅니다(기본 OpenAI, `EMBEDDING_BASE_URL`을 정하면 그 서버). OCR을 켜면 스캔 파일을 Mathpix로 보냅니다.
   Models 화면에서 연결한 언어 모델에는 채팅하거나 위키를 쓰는 동안에만 문서의 글이 전달됩니다. 연결할 때는 키를 확인하는 짧은 질문 하나만 보냅니다. 키는 `.env`에 있고(`LLM_PROVIDER`, `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`) 화면으로 다시 보내지 않습니다. 검색 도우미의 모델에는 찾는 동안(`find_documents`, 또는 그것을 재는 동안) 문서의 발췌와 일부가 전달됩니다. 검색용으로 따로 정한 모델은 `SEARCH_LLM_PROVIDER`, `SEARCH_LLM_API_KEY`, `SEARCH_LLM_BASE_URL`, `SEARCH_LLM_MODEL`에 있습니다. 저장한 키는 그 키를 받은 제공자와 주소로만 보냅니다.
5. 서비스 계정 주소를 아는 사람은 누구나 그 계정에 문서를 공유할 수 있습니다. Drive는 받는 쪽에 묻지 않습니다. 그래서 root 밖 공유 문서는 공유된 맨 위 항목의 소유자가 `drive.trustedOwners`에 있을 때만 보여 줍니다. 이 목록에는 자기 조직만 넣고 `*`는 쓰지 마십시오. 신뢰하는 소유자가 공유한 문서는 `drive` 도구를 쓸 수 있는 모든 사용자에게 보입니다. 민감한 폴더 이름은 `drive.excludeFolders`에 넣으십시오.
6. 토큰은 자기가 읽을 수 있는 곳까지 닿습니다. Slack 봇, GitHub 토큰, Railway 토큰은 모든 사용자가 봐도 되는 범위로만 줍니다.
7. 데이터베이스 연결은 그 데이터베이스 사용자가 읽을 수 있는 것을 모두 읽습니다. 읽기만 되는 전용 사용자를 만드십시오. superuser와 애플리케이션이 쓰는 사용자는 쓰지 마십시오. `explore`를 켤 때는 허용된 사람 모두가 봐도 되는 것만 읽는 사용자를 쓰십시오. tools 목록이 없는 member는 모든 연결을 쓸 수 있습니다.
8. 콘솔은 관리자 권한으로 설정을 바꾸고 도구를 실행합니다. 그래서 그 컴퓨터 앞에 앉은 사람에게만 엽니다. 서버를 터미널에서 띄웠거나 `KNOWLEDGE_CONSOLE=on`일 때만 있습니다. 다른 주소에서 온 요청, 전달 헤더가 붙은 요청, `localhost`가 아닌 호스트 이름으로 온 요청, 브라우저가 다른 사이트에서 왔다고 표시한 요청은 거절합니다. API는 콘솔 토큰이 있어야 하고, 화면은 서버 밖에서 아무것도 불러오지 않습니다. 알아 둘 한계가 둘 있습니다. 같은 컴퓨터의 리버스 프록시가 전달 헤더를 붙이지 않으면(nginx 기본 `proxy_pass`) 로컬 브라우저와 구별되지 않습니다. 서버에서는 콘솔을 꺼 두십시오. 여러 사람이 쓰는 컴퓨터에서는 모든 사용자가 `localhost`에 닿습니다. 이때 막아 주는 것은 소유자만 읽는 토큰 파일입니다.
9. 콘솔 토큰은 관리자의 열쇠입니다. 가진 사람은 모든 설정을 바꿀 수 있고, `.env`의 비밀값을 자기가 고른 주소로 보내는 연결을 만들 수 있습니다(연결이 원래 하는 일입니다). 콘솔은 이 범위를 그 폴더의 `.env`에 있는 비밀값으로 좁힙니다. 서버 자신의 자격 증명 이름이나 서버가 셸에서 물려받기만 한 변수를 가리키는 `${NAME}`은 거절합니다.
10. 콘솔에서 한 로그인은 데이터 폴더에 저장합니다(`railway-login.json`, `google-login.json`, `mcp-logins/`). 데이터 파일처럼 소유자만 읽을 수 있습니다. 구글 로그인은 로그인한 사람의 권한으로 읽습니다. 고른 폴더에 든 것은 서버의 모든 사용자에게 보이므로, 모두가 봐도 되는 폴더만 고르십시오. 로그인 뒤 브라우저가 돌아오는 주소는 콘솔이 몇 분 안에 시작한 로그인의 응답만 받고, 스스로는 아무것도 저장하지 않습니다.
11. MCP 서버로 추가한 앱은 로그인한 계정의 권한으로 동작하고, 그 앱의 도구를 쓸 수 있는 모든 사용자에게 열립니다. 변경을 허용하지 않으면 읽는 도구만 켜집니다. 어떤 도구가 읽기인지는 그 앱이 도구마다 붙인 표시를 따르므로, 믿을 수 있는 서버만 추가하십시오. 도구가 돌려주는 글은 그 앱의 글이지 지시가 아닙니다.

## 파일 구성

| 경로 | 내용 |
| --- | --- |
| [`packages/knowledge-mcp/src/plugin/`](packages/knowledge-mcp/src/plugin/) | 플러그인 API: `definePlugin`, `defineTool`, 등록부, 불러오기, 결과 모양 맞추기 |
| [`packages/knowledge-mcp/src/core/`](packages/knowledge-mcp/src/core/) | 인증, OAuth, 권한, 설정, 게이트웨이, 로그 가리기 |
| [`packages/knowledge-mcp/src/server/`](packages/knowledge-mcp/src/server/) | HTTP와 stdio 연결, MCP 요청 처리, 사용자 역할 계산 |
| [`packages/knowledge-mcp/src/store/`](packages/knowledge-mcp/src/store/) | 저장소 인터페이스, SQLite와 Supabase 구현 |
| [`packages/knowledge-mcp/src/plugins/`](packages/knowledge-mcp/src/plugins/) | 기본 플러그인: `knowledge`, `drive`, `slack`, `github`, `railway` |
| [`packages/knowledge-mcp/src/connections/`](packages/knowledge-mcp/src/connections/) | 설정에 적는 도구: Postgres, SQLite, HTTP 연결 |
| [`packages/knowledge-mcp/src/admin/`](packages/knowledge-mcp/src/admin/) | 콘솔 API, 접근 규칙, 저장 뒤 서버를 다시 시작하는 장치 |
| [`packages/knowledge-mcp/console/`](packages/knowledge-mcp/console/) | 콘솔 화면(React). `dist/console-ui`로 빌드합니다. 입력 부품은 [affectUI](https://github.com/flohoeller/affectui) 컴포넌트를 `src/ui`에 복사한 것입니다(MIT, 그 폴더의 안내문 참고) |
| [`packages/knowledge-mcp/src/run.ts`](packages/knowledge-mcp/src/run.ts) | 명령줄 |
| [`packages/knowledge-mcp/test/`](packages/knowledge-mcp/test/) | 단위 시험, HTTP와 stdio 종단 시험 |
| [`packages/create-knowledge-mcp/`](packages/create-knowledge-mcp/) | 생성기와 프로젝트 템플릿 |
| [`scripts/smoke-create.sh`](scripts/smoke-create.sh) | 묶기, 생성, 설치, 빌드, 서버 실행, 호출까지 한 번에 확인 |
| [`Dockerfile`](Dockerfile), [`compose.yaml`](compose.yaml), [`railway.toml`](railway.toml) | 이미지, 로컬 실행, Railway |
| [`.github/`](.github/) | CI, 이미지와 npm 워크플로, 이슈와 PR 양식, README 그림(`assets/make.py`) |

개발할 때는 `npm install`, `npm test`(단위와 종단), `npm run typecheck`, `npm run smoke:create`를 씁니다.

## 기여

문제와 아이디어는 이슈로 남겨 주세요.

| 양식 | 이럴 때 씁니다 |
| --- | --- |
| [**버그 제보**](https://github.com/chanthr/internal-mcp/issues/new?template=01-bug.yml) | 코드나 문서와 다르게 동작할 때 |
| [**개선 제안**](https://github.com/chanthr/internal-mcp/issues/new?template=02-improvement.yml) | 더 나은 방법이 있거나 문서가 코드와 맞지 않을 때 |

이 저장소는 공개입니다. 이슈와 PR에 API 키, 토큰, 내부 주소, 비공개 문서를 넣지 마세요. 보안 문제는 이슈 대신
Security 탭의 [**Report a vulnerability**](https://github.com/chanthr/internal-mcp/security/advisories/new)로 비공개 제보해 주세요.

## 라이선스

[MIT](LICENSE) © chanthr
