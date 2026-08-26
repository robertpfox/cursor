import config from '../../config.js';
import { settings } from '../../db/index.js';
import { badRequest, HttpError, unauthorized } from '../router.js';
import {
  authenticate,
  beginSession,
  createApiToken,
  createUser,
  endSession,
  listApiTokens,
  needsSetup,
  requireAuth,
  revokeApiToken,
} from '../auth.js';

export function registerAuthRoutes(router) {
  router.get('/api/session', (ctx) => ({
    authenticated: Boolean(ctx.user),
    needsSetup: needsSetup(),
    setupAllowed: config.allowSetup,
    user: ctx.user,
    version: config.version,
  }));

  router.post('/api/setup', (ctx) => {
    if (!needsSetup()) throw new HttpError(409, 'This instance already has an owner.');
    if (!config.allowSetup) throw new HttpError(403, 'Setup is disabled. Create the owner with the CLI.');
    const user = createUser({
      username: ctx.body.username,
      password: ctx.body.password,
      displayName: ctx.body.displayName,
    });
    if (ctx.body.displayName) settings.set('general.ownerName', ctx.body.displayName);
    beginSession(ctx, user);
    return { user };
  });

  router.post('/api/login', (ctx) => {
    const user = authenticate(ctx.body.username, ctx.body.password);
    if (!user) throw unauthorized('Wrong username or password.');
    beginSession(ctx, user);
    return { user };
  });

  router.post('/api/logout', (ctx) => {
    endSession(ctx);
    return { ok: true };
  });

  router.get('/api/tokens', (ctx) => listApiTokens(requireAuth(ctx).id));

  router.post('/api/tokens', (ctx) => {
    const user = requireAuth(ctx);
    if (!ctx.body.name?.trim()) throw badRequest('Give the token a name so you can recognise it later.');
    // Shown once; only the digest is stored.
    return { token: createApiToken(user.id, ctx.body.name) };
  });

  router.delete('/api/tokens/:id', (ctx) => {
    revokeApiToken(requireAuth(ctx).id, ctx.params.id);
    return { ok: true };
  });
}

export default registerAuthRoutes;
