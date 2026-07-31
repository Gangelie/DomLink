import express from 'express';
import bcrypt from 'bcryptjs';

export function createAuthRouter(cfg, persist) {
  const router = express.Router();

  router.get('/status', (req, res) => {
    res.json({
      authenticated: !!(req.session && req.session.authenticated),
      mustChangePassword: !!cfg.mustChangePassword,
    });
  });

  router.post('/login', (req, res) => {
    const { password } = req.body || {};
    if (typeof password !== 'string' || !password) {
      return res.status(400).json({ error: 'Passwort erforderlich' });
    }

    if (!bcrypt.compareSync(password, cfg.passwordHash)) {
      return res.status(401).json({ error: 'Falsches Passwort' });
    }

    req.session.authenticated = true;
    res.json({ ok: true, mustChangePassword: !!cfg.mustChangePassword });
  });

  router.post('/logout', (req, res) => {
    req.session.destroy(() => {
      res.json({ ok: true });
    });
  });

  router.post('/change-password', (req, res) => {
    if (!req.session || !req.session.authenticated) {
      return res.status(401).json({ error: 'Nicht angemeldet' });
    }

    const { currentPassword, newPassword, confirmPassword } = req.body || {};

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ error: 'Alle Felder sind erforderlich' });
    }
    if (!bcrypt.compareSync(currentPassword, cfg.passwordHash)) {
      return res.status(401).json({ error: 'Aktuelles Passwort ist falsch' });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: 'Neue Passwörter stimmen nicht überein' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Neues Passwort muss mindestens 6 Zeichen lang sein' });
    }

    cfg.passwordHash = bcrypt.hashSync(newPassword, 10);
    cfg.mustChangePassword = false;
    persist();

    res.json({ ok: true });
  });

  return router;
}

export function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  res.status(401).json({ error: 'Nicht angemeldet' });
}
