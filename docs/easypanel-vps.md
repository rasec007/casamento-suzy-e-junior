# Publicar em VPS com EasyPanel

Este roteiro publica a aplicação em `casamento-suzy-e-junior.c2net.com.br`, usa o PostgreSQL externo já configurado e instala a aplicação a partir do GitHub com o `Dockerfile` do repositório.

## 1. Preparar o VPS

1. Confirme que o VPS tem Ubuntu suportado pelo EasyPanel, pelo menos 2 GB de RAM e acesso administrativo.
2. Aponte os registros DNS para o IP público do VPS. Para este hostname, crie um registro `A` com nome `casamento-suzy-e-junior` apontando para o IPv4. Crie `AAAA` somente se o VPS tiver IPv6 público e firewall configurado para ele.
3. Libere as portas TCP 80 e 443 para o proxy HTTPS do EasyPanel. Mantenha a porta 3000 fechada para a internet; ela será usada internamente pelo proxy.
4. Instale o EasyPanel no VPS seguindo o [guia oficial de instalação](https://easypanel.io/docs). O instalador oficial precisa rodar como `root` em um VPS novo; ele instala Docker quando necessário e inicializa o painel.
5. Entre no painel pelo endereço administrativo fornecido pelo EasyPanel e crie um projeto chamado `casamento-suzy-junior`.

Se o DNS estiver em uma zona gerenciada por outra equipe ou provedor, peça que publiquem o registro A para o IP do VPS. A emissão do certificado HTTPS depende de o hostname já resolver para o servidor e das portas 80/443 estarem acessíveis.

## 2. Enviar o projeto ao GitHub

1. O repositório local já tem `origin` configurado para `rasec007/casamento-suzy-e-junior` na branch `main`.
2. Confira que o último commit foi enviado. No repositório local, `git status` deve mostrar a branch sincronizada.
3. Não adicione `.env` ao Git. `.env` contém senhas; o `.gitignore` já exclui esse arquivo.
4. Se o repositório for privado, conecte sua conta GitHub ao EasyPanel ou configure no servidor o token de GitHub com acesso somente de leitura ao repositório.

## 3. Criar o serviço Node no EasyPanel

1. Abra o projeto e escolha **Create Service → App**.
2. Em **Source**, selecione **GitHub**. Informe `rasec007/casamento-suzy-e-junior`, a branch `main` e Build Path `/`.
3. Em **Build**, escolha **Dockerfile** e informe `Dockerfile` como caminho. O contexto deve continuar `/`.
4. Salve a configuração. O Dockerfile instala apenas as dependências de produção, copia o backend e os arquivos estáticos e executa Node como o usuário sem privilégios `node`.
5. Não configure uma porta pública direta para o container. O EasyPanel encaminha o domínio pela proxy para a porta interna da aplicação.

O EasyPanel reconhece um `Dockerfile` no build path e consegue construir a imagem diretamente do GitHub. Se a versão do painel mostrar outra disposição de menus, siga a seção **Source**, depois **Build** e **Domains** do [guia oficial de App Service](https://easypanel.io/docs/services/app) e dos [builders](https://easypanel.io/docs/builders).

## 4. Configurar variáveis e segredos

Na aba **Environment** do serviço App, cadastre as variáveis abaixo. Use os valores do `.env` local; não copie o `.env` para o repositório nem para uma imagem Docker.

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
APP_URL=https://casamento-suzy-e-junior.c2net.com.br
TRUST_PROXY=true
DATABASE_URL=postgresql://suzy_junior_app:SENHA_DA_ROLE@HOST_DO_POSTGRES:5446/suzy_junior
ADMIN_PASSWORD=SENHA_FORTE_DO_PAINEL
SESSION_SECRET=SEGREDO_ALEATORIO_COM_PELO_MENOS_32_CARACTERES
EVOLUTION_API_URL=https://evolutionapi.c2net.com.br/message/sendText/cpu
EVOLUTION_API_KEY=CHAVE_DA_EVOLUTION_API
```

Use no `DATABASE_URL` a senha gerada para `suzy_junior_app` e o hostname/porta atuais do banco externo. Se a senha tiver caracteres reservados em URL (`@`, `:`, `/`, `?`, `#`, `%`), faça percent-encoding antes de montá-la. A senha gerada para a role neste ambiente contém somente hexadecimal e pode ser usada diretamente.

`HOST=0.0.0.0` permite que a proxy do EasyPanel alcance o Node dentro do container. `TRUST_PROXY=true` faz o Fastify reconhecer HTTPS e o hostname encaminhados pela proxy; use isso somente atrás da proxy do EasyPanel. `APP_URL` é a origem canônica e a origem aceita nas operações protegidas contra CSRF.

Confira na área **Network/Networking** do serviço PostgreSQL externo que conexões originadas do VPS/EasyPanel podem alcançar o host e a porta configurados. Não abra a porta do PostgreSQL para toda a internet; prefira a rede privada ou libere somente o IP de saída do VPS.

## 5. Associar domínio e HTTPS

1. No serviço App, abra **Domains** e adicione `casamento-suzy-e-junior.c2net.com.br`.
2. Configure o protocolo de destino como HTTP e a porta de destino como `3000`.
3. Ative HTTPS/certificado Let's Encrypt no EasyPanel e marque este hostname como domínio principal.
4. Aguarde a validação do DNS e a emissão do certificado. Acesse `https://casamento-suzy-e-junior.c2net.com.br`.

O domínio do serviço encaminha tráfego HTTP pela proxy do EasyPanel para a porta interna definida. Veja os passos atuais de domínio em [App Service → Domains](https://easypanel.io/docs/services/app).

## 6. Fazer o primeiro deploy e verificar

1. Salve fonte, build, environment e domínio.
2. Clique **Deploy** e acompanhe os logs de build e de runtime.
3. No log de runtime, procure `Server listening at http://0.0.0.0:3000`.
4. Abra `https://casamento-suzy-e-junior.c2net.com.br/api/health`; a resposta esperada é `{"status":"ok","database":"connected"}`.
5. Abra a página principal e teste RSVP com seu próprio WhatsApp. A confirmação deve chegar ao número informado. Um RSVP é mantido mesmo quando a EvolutionAPI não responde; nesse caso a interface mostra que o envio falhou.
6. Faça login no **Painel dos Noivos**, confira fornecedores e convidados e confirme que as atualizações realtime aparecem após criar ou alterar registros.
7. Confirme no navegador que o certificado é válido e que a página principal redireciona/abre em HTTPS.

A primeira inicialização cria as tabelas e carrega os dados de demonstração de `modelo/` quando a tabela de presentes está vazia. Antes de usar com convidados reais, revise e remova os registros demonstrativos no banco/painel.

## 7. Atualizações seguintes

1. Faça alterações e testes localmente.
2. Envie commits aprovados para `main` no GitHub.
3. Se habilitar auto deploy do GitHub, cada push poderá iniciar um deployment. Caso contrário, abra o serviço no EasyPanel e clique **Deploy**.
4. Acompanhe o build e faça uma checagem de `/api/health` e do RSVP após a publicação.
5. Guarde as variáveis do painel em um cofre seguro. Gere uma nova `SESSION_SECRET` ou senha somente quando for necessário rotacioná-las; a troca de `SESSION_SECRET` encerra as sessões administrativas atuais.

## 8. Diagnóstico rápido

- **Build falha no `npm ci`:** confira se `package-lock.json` foi enviado junto com `package.json` e force um novo build sem cache.
- **Container reinicia ou falha em `/api/health`:** confira `DATABASE_URL`, DNS/rede do PostgreSQL e permissões da role `suzy_junior_app`.
- **502 no domínio:** confira que `HOST=0.0.0.0`, `PORT=3000` e a porta de destino do domínio também é `3000`.
- **POSTs recebem 403:** confirme `APP_URL` sem barra ou caminho extra e `TRUST_PROXY=true` atrás da proxy do EasyPanel.
- **Cookie do painel não persiste:** use HTTPS, `NODE_ENV=production` e confira se o navegador aceita cookies.
- **RSVP salvo sem WhatsApp enviado:** confira `EVOLUTION_API_URL`, a chave e o estado da instância `cpu` nos logs da EvolutionAPI.
- **Certificado não é emitido:** confirme que o registro A já aponta para o VPS e que as portas 80 e 443 estão abertas.
