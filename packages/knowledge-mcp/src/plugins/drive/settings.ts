/**
 * Drive 색인 범위와 한도 — 가벼운 상수만 둔다. 도구들이 이 값 때문에 색인기(indexer.ts, 토크나이저·Qdrant)를
 * 통째로 불러오지 않게 따로 뺐다.
 */
import { getConfig } from '../../core/config.js';

/** Drive index roots (SSOT for full reindex + incremental sync). Configured via config.drive.roots. */
export const DRIVE_ROOTS = getConfig().drive.roots;

/**
 * 색인·읽기 파일 크기 상한(바이트). 파일을 통째로 메모리에 올리므로, 거대한 파일 하나가 서버를 죽이지 않게 막는다.
 * Google 문서·시트·슬라이드는 Drive 메타에 size 가 없어(export) 이 검사를 받지 않는다.
 */
export const MAX_FILE_BYTES = Number(process.env.DRIVE_MAX_FILE_BYTES ?? 50_000_000);
