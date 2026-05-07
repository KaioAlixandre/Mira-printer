const bcrypt = require('bcrypt');

// Senha que você deseja criptografar
const passwordToHash = 'Kt.61424';

async function hashPassword() {
    try {
        const hashedPassword = await bcrypt.hash(passwordToHash, 10);
        console.log('Senha criptografada:', hashedPassword);
    } catch (error) {
        console.error('Erro ao criptografar a senha:', error);
    }
}

hashPassword();