/**
 * Drive 증분 sync 의 pageToken 영속화 — 저장소 plugin state (namespace "drive", key "pageToken").
 *
 * 로컬 파일은 컨테이너 재배포마다 사라져(ephemeral) 재배포~다음 전체 reindex 사이의 Drive 변경분이
 * 인덱스에 영구 누락됐다. 그래서 저장소(SQLite 파일은 볼륨, 또는 Supabase)에 둔다.
 *
 * 읽기 실패는 throw 한다. 예전엔 null(= 첫 실행)로 취급해 "지금부터" 토큰으로 덮어써,
 * 일시 장애 한 번에 그 사이 변경분을 영구히 놓쳤다. 이제 그 주기만 건너뛰고 다음 주기에 다시 읽는다.
 */
import { getStore } from '../../store/index.js';

const NS = 'drive';
const KEY = 'pageToken';

/** 저장된 토큰. 없으면 null(첫 실행). 저장소 오류는 throw. */
export async function getSyncToken(): Promise<string | null> {
  const v = await (await getStore()).getState(NS, KEY);
  return typeof v === 'string' && v ? v : null;
}

export async function setSyncToken(token: string): Promise<void> {
  try {
    await (await getStore()).setState(NS, KEY, token);
  } catch (e) {
    console.error('[sync_state] setSyncToken failed:', e instanceof Error ? e.message : e);
  }
}

// ── 실패한 파일 다시 시도 목록 ──
// 파일 하나가 실패해도(OpenAI 할당량 소진, Qdrant timeout) pageToken 은 전진한다(안 그러면 깨진 파일 하나에 동기화가
// 영원히 멈춘다). 그 대신 실패한 fileId 를 여기 쌓아 다음 주기에 다시 시도한다. 열 번 실패하면 버리고 로그를 남긴다
// (다음 전체 재색인이 줍는다).
const RETRY_KEY = 'retry';
export const MAX_RETRY_ATTEMPTS = 10;
const MAX_RETRY_FILES = 1000;

/** fileId → 지금까지 실패한 횟수. */
export async function getRetryList(): Promise<Record<string, number>> {
  const v = await (await getStore()).getState(NS, RETRY_KEY);
  return v && typeof v === 'object' ? (v as Record<string, number>) : {};
}

export async function setRetryList(list: Record<string, number>): Promise<void> {
  const entries = Object.entries(list).slice(-MAX_RETRY_FILES);
  try {
    await (await getStore()).setState(NS, RETRY_KEY, Object.fromEntries(entries));
  } catch (e) {
    console.error('[sync_state] setRetryList failed:', e instanceof Error ? e.message : e);
  }
}
