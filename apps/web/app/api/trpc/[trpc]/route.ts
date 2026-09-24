import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { createContext } from '@/server/context';
import { appRouter } from '@/server/routers';

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    createContext: () => createContext({ headers: req.headers }),
    onError({ error, path }) {
      if (error.code === 'INTERNAL_SERVER_ERROR') {
        console.error(`[trpc] ${path ?? '?'}:`, error.cause ?? error);
      }
    },
  });

export { handler as GET, handler as POST };
