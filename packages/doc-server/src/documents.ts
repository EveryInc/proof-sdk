import type { Router } from 'express';
import { apiRoutes, handleShareMarkdown, shareMarkdownBodyParser } from '../../../server/routes.js';

export {
  handleShareMarkdown,
  shareMarkdownBodyParser,
};

export function createDocumentRouter(): Router {
  return apiRoutes;
}

export { apiRoutes };
