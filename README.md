# Suzy & Junior — site de casamento

Site em HTML5, CSS e JavaScript puros com API Node.js/Fastify, PostgreSQL e atualizações em tempo real via `LISTEN/NOTIFY` e Server-Sent Events. O conteúdo e os dados iniciais vêm de `modelo/`.

## Requisitos

- Node.js 22 ou mais recente
- PostgreSQL 14 ou mais recente, local ou acessível pela `DATABASE_URL`
- MinIO/S3 acessível pela `MINIO_SERVER_URL`, com credenciais e bucket da aplicação
- Docker Compose opcional para subir o PostgreSQL local

## Iniciar localmente

1. Copie `.env.example` para `.env`; troque `ADMIN_PASSWORD` por uma senha forte e `POSTGRES_PASSWORD` por uma senha local. Atualize a senha correspondente em `DATABASE_URL`. Gere `SESSION_SECRET` com `openssl rand -hex 32`.
2. Com Docker disponível, execute `docker compose up -d postgres`. Sem Docker, crie um banco PostgreSQL chamado `suzy_junior` e ajuste `DATABASE_URL`.
3. Configure `MINIO_SERVER_URL`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` e `MINIO_BUCKET` no `.env`. O serviço cria o bucket privado ao iniciar; no painel dos noivos, a aba **Locais** permite alterar endereços, rotas do Google Maps e fotos (JPG, PNG ou WebP, até 5 MB).
4. Execute `npm ci` e `npm run dev`.
5. Acesse `http://127.0.0.1:3000`. A primeira inicialização aplica `server/schema.sql` e carrega os dados iniciais quando as tabelas de presentes estão vazias.

Para produção, defina `NODE_ENV=production`, use HTTPS, uma senha forte, segredo aleatório e um PostgreSQL gerenciado com backup. Configure `TRUST_PROXY=true` somente atrás de proxy reverso confiável.

O passo a passo para publicar no VPS com EasyPanel está em [`docs/easypanel-vps.md`](docs/easypanel-vps.md).

## Verificações

`npm run check` verifica a sintaxe dos módulos JavaScript. Os fluxos que escrevem dados, o login e o realtime precisam de uma instância PostgreSQL ativa.

## Fluxos incluídos

- Página pública: história, locais, presentes, Penseira, RSVP e Espelho de Ojesed.
- Área administrativa protegida: visão financeira resumida e gerenciamento de mensagens, confirmações e fornecedores.
- Privacidade: telefones aparecem apenas no painel dos noivos; não são incluídos nas respostas públicas.
- RSVP e mensagens são persistidos no PostgreSQL. O protótipo de presente registra intenção e mensagem, sem processar pagamento.
- Um RSVP válido recebe confirmação pelo WhatsApp informado; se a EvolutionAPI estiver fora, a presença permanece salva e o formulário avisa que o envio falhou.
