export function requireAuth(req, res, next){
  if (req.session.user) return next();
  res.redirect('/login');
}
export function requireRole(roles){
  return (req, res, next)=>{
    const u = req.session.user;
    if (!u) return res.redirect('/login');
    if (Array.isArray(roles) ? roles.includes(u.rol) : u.rol===roles) return next();
    return res.status(403).send('No autorizado');
  };
}
