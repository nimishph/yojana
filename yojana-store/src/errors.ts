import { YojanaError } from '@cntxt-labs/yojana-core';

export class StoreClosedError extends YojanaError {
  constructor(store: string) {
    super('STORE_CLOSED', `the ${store} store is not open`, { hint: 'call open() first' });
    this.name = 'StoreClosedError';
  }
}

export class CorruptStoreError extends YojanaError {
  readonly source: string;
  readonly atSeq: number;

  constructor(source: string, atSeq: number) {
    super('STORE_CORRUPT', `${source} is unreadable from event ${atSeq}; writes are refused`, {
      hint: 'run repair to move the unreadable tail aside and keep every good event',
    });
    this.name = 'CorruptStoreError';
    this.source = source;
    this.atSeq = atSeq;
  }
}
