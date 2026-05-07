const nodemailer = require('nodemailer');

class EmailService {
    constructor() {
        // Configuração do transporter - usando Gmail como exemplo
        // Para produção, considere usar serviços como SendGrid, AWS SES, etc.
        
        // Verificar se as credenciais estão configuradas
        const hasEmailConfig = process.env.EMAIL_USER && 
                              process.env.EMAIL_PASSWORD && 
                              process.env.EMAIL_USER !== 'your-email@gmail.com';
        
        if (hasEmailConfig) {
            this.transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: {
                    user: process.env.EMAIL_USER,
                    pass: process.env.EMAIL_PASSWORD
                }
            });
            this.isConfigured = true;
        } else {
            console.log('⚠️ Email não configurado - usando modo de desenvolvimento');
            this.transporter = null;
            this.isConfigured = false;
        }
    }

    // Gerar código de verificação de 6 dígitos
    generateVerificationCode() {
        return Math.floor(100000 + Math.random() * 900000).toString();
    }

    // Enviar email com código de verificação
    async sendPasswordResetEmail(email, verificationCode) {
        // Se não está configurado, simular o envio para desenvolvimento
        if (!this.isConfigured) {
            console.log('📧 [MODO DESENVOLVIMENTO] Email simulado para:', email);
            console.log('🔑 [CÓDIGO DE VERIFICAÇÃO]:', verificationCode);
            console.log('📝 [INSTRUÇÕES] Use este código na tela de redefinição de senha');
            
            // Simular delay de envio de email
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            return { success: true, development: true };
        }

        const mailOptions = {
            from: process.env.EMAIL_USER || 'noreply@miradelivery.com.br',
            to: email,
            subject: 'Redefinição de Senha - Mira Delivery',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                    <div style="text-align: center; margin-bottom: 30px;">
                        <h1 style="color: #8B5CF6; margin: 0;">🍓 Mira Delivery</h1>
                    </div>
                    
                    <div style="background-color: #f8f9fa; padding: 30px; border-radius: 10px; border-left: 4px solid #8B5CF6;">
                        <h2 style="color: #333; margin-top: 0;">Redefinição de Senha</h2>
                        <p style="color: #666; font-size: 16px; line-height: 1.5;">
                            Você solicitou a redefinição de sua senha. Use o código abaixo para continuar:
                        </p>
                        
                        <div style="text-align: center; margin: 30px 0;">
                            <div style="display: inline-block; background-color: #8B5CF6; color: white; padding: 15px 30px; border-radius: 8px; font-size: 24px; font-weight: bold; letter-spacing: 3px;">
                                ${verificationCode}
                            </div>
                        </div>
                        
                        <p style="color: #666; font-size: 14px; line-height: 1.5;">
                            <strong>Este código expira em 15 minutos.</strong><br>
                            Se você não solicitou esta redefinição, ignore este email.
                        </p>
                    </div>
                    
                    <div style="text-align: center; margin-top: 30px; color: #999; font-size: 12px;">
                        <p>© 2024 Mira Delivery. Todos os direitos reservados.</p>
                    </div>
                </div>
            `
        };

        try {
            await this.transporter.sendMail(mailOptions);
            console.log(`📧 Email de redefinição de senha enviado para: ${email}`);
            return { success: true };
        } catch (error) {
            console.error('❌ Erro ao enviar email:', error);
            return { success: false, error: error.message };
        }
    }

    // Testar configuração do email
    async testConnection() {
        if (!this.isConfigured) {
            console.log('⚠️ Email em modo de desenvolvimento - sem configuração real');
            return true;
        }
        
        try {
            await this.transporter.verify();
            console.log('✅ Configuração de email verificada com sucesso');
            return true;
        } catch (error) {
            console.error('❌ Erro na configuração de email:', error);
            return false;
        }
    }
}

module.exports = new EmailService();