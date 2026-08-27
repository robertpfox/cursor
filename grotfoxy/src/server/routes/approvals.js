import { badRequest, notFound } from '../router.js';
import { requireAuth } from '../auth.js';
import { decideApproval, getApproval, listPending } from '../../services/approvals.js';
import { getBot } from '../../services/bots.js';
import { getRun } from '../../services/runs.js';
import { resumeRun } from '../../runtime/runner.js';

export function registerApprovalRoutes(router) {
  router.get('/api/approvals', (ctx) => {
    requireAuth(ctx);
    return listPending().map((approval) => {
      const bot = getBot(approval.botId);
      const record = getRun(approval.runId);
      return {
        ...approval,
        bot: bot ? { id: bot.id, name: bot.name, emoji: bot.emoji, color: bot.color } : null,
        task: record?.task ?? '',
      };
    });
  });

  router.post('/api/approvals/:id/decide', (ctx) => {
    const user = requireAuth(ctx);
    const approval = getApproval(ctx.params.id);
    if (!approval) throw notFound('Approval not found');
    if (approval.status !== 'pending') return approval;

    const decision = String(ctx.body.decision ?? '').toLowerCase();
    const note = String(ctx.body.note ?? '');

    let status;
    if (approval.kind === 'question') {
      if (!note.trim()) throw badRequest('Type an answer before sending it back.');
      status = 'answered';
    } else if (decision === 'approve' || decision === 'approved') {
      status = 'approved';
    } else if (decision === 'deny' || decision === 'denied') {
      status = 'denied';
    } else {
      throw badRequest('Decision must be "approve" or "deny".');
    }

    const updated = decideApproval(approval.id, status, { note, decidedBy: user.username });
    resumeRun(approval.runId);
    return updated;
  });
}

export default registerApprovalRoutes;
