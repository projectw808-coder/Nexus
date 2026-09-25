import { router, userProcedure } from '../trpc';
import { auditRouter } from './audit';
import { connectionRouter } from './connections';
import { conversationRouter } from './conversations';
import { exportRouter } from './export';
import { importRouter } from './imports';
import { invitationRouter } from './invitation';
import { listEntryRouter, listRouter } from './lists';
import { memberRouter } from './member';
import { noteRouter } from './notes';
import { attributeRouter, objectTypeRouter } from './objects';
import { companyRouter, dealRouter, personRouter, recordRouter } from './records';
import { searchRouter } from './search';
import { taskRouter } from './tasks';
import { viewRouter } from './views';
import { workspaceRouter } from './workspace';

export const appRouter = router({
  me: router({
    get: userProcedure.query(({ ctx }) => ctx.session),
  }),
  workspace: workspaceRouter,
  member: memberRouter,
  invitation: invitationRouter,
  audit: auditRouter,
  // Phase 2 — the object graph
  objectType: objectTypeRouter,
  attribute: attributeRouter,
  record: recordRouter,
  person: personRouter,
  company: companyRouter,
  deal: dealRouter,
  list: listRouter,
  listEntry: listEntryRouter,
  view: viewRouter,
  search: searchRouter,
  import: importRouter,
  export: exportRouter,
  note: noteRouter,
  task: taskRouter,
  // Phase 4 — connector runtime
  connection: connectionRouter,
  // Phase 5 — conversations (bare inbox)
  conversation: conversationRouter,
});

export type AppRouter = typeof appRouter;
