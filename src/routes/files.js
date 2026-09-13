import { Router } from 'express';
import { resolvePath, verifySignature } from '../lib/storage.js';

export const filesRouter = Router();

/* Serves the links storage.signedUrl() hands out. The signature and its
   expiry are the whole permission: <img> tags in the mini-app and the panel
   carry no session worth trusting, and a link is only ever given to a page
   that was allowed to show the picture. */
filesRouter.get('/*', (req, res) => {
  const rel = req.params[0];
  const full = resolvePath(rel);
  if (!full || !verifySignature(rel, req.query.e, req.query.s)) {
    return res.status(404).json({ error: 'Not found' });
  }

  res.sendFile(full, {
    cacheControl: false,
    headers: { 'Cache-Control': 'private, max-age=600' }
  }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Not found' });
  });
});
