import { router, userProcedure } from '../trpc';
import { auditRouter } from './audit';
import { invitationRouter } from './invitation';
import { memberRouter } from './member';
import { workspaceRouter } from './workspace';

export const appRouter = router({
  me: router({
    get: userProcedure.query(({ ctx }) => ctx.session),
  }),
  workspace: workspaceRouter,
  member: memberRouter,
  invitation: invitationRouter,
  audit: auditRouter,
});

export type AppRouter = typeof appRouter;
