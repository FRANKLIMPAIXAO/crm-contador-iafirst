// src/db/seed.ts
// Cria a org inicial + usuário admin
// Uso: ADMIN_EMAIL=... ADMIN_SENHA=... ADMIN_NOME=... ORG_NOME=... ORG_SLUG=... npx tsx src/db/seed.ts
import { pool, queryOne } from './connection.js';
import { hashSenha } from '../auth/hash.js';

async function seed() {
  const orgNome = process.env.ORG_NOME || 'PAC Inteligência Tributária';
  const orgSlug = process.env.ORG_SLUG || 'pac';
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
  const adminSenha = process.env.ADMIN_SENHA || 'troque-isso-agora';
  const adminNome = process.env.ADMIN_NOME || 'Admin';

  console.log(`📋 Criando org "${orgNome}" (${orgSlug})...`);
  const org = await queryOne<{ id: string }>(
    `INSERT INTO orgs (nome, slug) VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET nome = EXCLUDED.nome
     RETURNING id`,
    [orgNome, orgSlug],
  );
  if (!org) throw new Error('falha ao criar org');
  console.log(`   ✅ org_id = ${org.id}`);

  console.log(`\n👤 Criando admin ${adminEmail}...`);
  const senhaHash = await hashSenha(adminSenha);
  const user = await queryOne<{ id: string }>(
    `INSERT INTO users (org_id, email, senha_hash, nome, papel)
     VALUES ($1, $2, $3, $4, 'admin')
     ON CONFLICT (email) DO UPDATE SET senha_hash = EXCLUDED.senha_hash, nome = EXCLUDED.nome
     RETURNING id`,
    [org.id, adminEmail, senhaHash, adminNome],
  );
  console.log(`   ✅ user_id = ${user?.id}`);
  console.log(`\n🎉 Seed completo. Faça login com:`);
  console.log(`   email: ${adminEmail}`);
  console.log(`   senha: ${adminSenha}`);
  console.log(`\n⚠️  Troque a senha imediatamente em produção.`);

  await pool.end();
}

seed().catch((e) => {
  console.error('❌ seed falhou:', e);
  process.exit(1);
});
