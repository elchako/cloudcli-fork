import { createContext, useContext } from 'react';

// GOLDJAXE fork (реестр §4.1-тер): UI видит только состав сеансов, не запросы.
export const NO_WAITING_SESSIONS: ReadonlySet<string> = new Set();
export const WaitingConfirmationIdsContext = createContext(NO_WAITING_SESSIONS);

export function useWaitingConfirmationIds(): ReadonlySet<string> {
  return useContext(WaitingConfirmationIdsContext);
}
