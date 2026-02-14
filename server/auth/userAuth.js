const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

function generateToken(user, secret) {
  const payload = {
    id: user.id,
    username: user.username,
    role: user.role
  };
  return jwt.sign(payload, secret, { expiresIn: '8h' });
}

function verifyToken(token, secret) {
  try {
    return jwt.verify(token, secret);
  } catch (error) {
    return null;
  }
}

async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

module.exports = {
  generateToken,
  verifyToken,
  hashPassword,
  comparePassword
};
