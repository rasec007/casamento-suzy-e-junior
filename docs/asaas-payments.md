# Configurar pagamentos com Asaas

Este projeto usa uma integração por casamento: cada casal conecta a própria conta Asaas e recebe os valores diretamente nela. A plataforma não centraliza nem divide os recebimentos. O pagamento é concluído numa página hospedada pelo Asaas; os dados do cartão não passam pelo site.

## 1. Preparar a aplicação

1. Gere uma chave de criptografia com 32 bytes:

   ```bash
   openssl rand -hex 32
   ```

2. Salve o resultado como `PAYMENTS_ENCRYPTION_KEY` no `.env` local e no ambiente do serviço no EasyPanel. Deve ter exatamente 64 caracteres hexadecimais.
3. Faça backup seguro desse segredo. As chaves Asaas salvas no banco são protegidas com AES-256-GCM usando essa variável. Se ela for perdida ou trocada sem recriptografar os dados, o sistema não conseguirá recuperar as chaves guardadas.
4. Aplique o schema atualizado:

   ```bash
   npm run db:migrate
   ```

5. Reinicie o servidor. A nova aba **Pagamentos** aparece no Painel dos Noivos.

Em desenvolvimento local, o Asaas precisa alcançar o endpoint de Webhook pela Internet. Para isso, use um túnel HTTPS temporário e configure sua URL em `PAYMENTS_WEBHOOK_BASE_URL`; não cadastre `localhost` ou `127.0.0.1` no Asaas. Remova a variável quando não precisar mais do túnel. Em produção, a aplicação monta a URL pública usando `APP_URL`.

## 2. Criar a conta de testes (Sandbox)

1. Abra o [Sandbox do Asaas](https://sandbox.asaas.com/) e crie uma conta de testes. Ela é separada da conta de produção.
2. Na conta Sandbox, abra **Integrações → Chaves de API** e crie uma chave para a integração.
3. Copie a chave quando o Asaas a mostrar. Ela não deve ser colocada no HTML, JavaScript, Git, logs ou em mensagens.
4. Entre no site com o e-mail e senha do casamento e abra **Painel dos Noivos → Pagamentos**.
5. Selecione **Sandbox**, cole a chave e salve. O backend a criptografa antes de gravar no PostgreSQL. O campo não volta a exibir a chave depois de salva.
6. Abra **Configurar o Webhook no Asaas** e copie a URL e o token que o painel mostrou. Guarde o token em cofre de senhas; se ele se perder, gere outro no painel e substitua-o também no Asaas.
7. Clique **Testar conexão com o Asaas**. A conta só será marcada como validada se a API aceitar a chave no ambiente escolhido.

As URLs oficiais são `https://api-sandbox.asaas.com/v3` para Sandbox e `https://api.asaas.com/v3` para produção. O sistema escolhe a URL pelo ambiente selecionado e envia a credencial no cabeçalho `access_token`.

## 3. Cadastrar o Webhook no Sandbox

1. Na conta Sandbox, abra **Integrações → Webhooks** e crie um Webhook.
2. Cole a URL HTTPS exibida na aba Pagamentos. Ela termina em `/api/webhooks/asaas/` e um identificador do casamento; mantenha o caminho completo.
3. Informe um e-mail que os noivos acompanhem para receber alertas de falha do Webhook.
4. Configure API versão `3`, deixe o Webhook ativo e selecione o envio **sequencial**.
5. Cole exatamente o token de Webhook fornecido pelo painel dos noivos no campo de autenticação. O Asaas o envia no cabeçalho `asaas-access-token`.
6. Selecione estes eventos:

   - `CHECKOUT_CREATED`, `CHECKOUT_PAID`, `CHECKOUT_CANCELED`, `CHECKOUT_EXPIRED`;
   - `PAYMENT_RECEIVED`, `PAYMENT_REFUND_IN_PROGRESS`, `PAYMENT_REFUND_DENIED`, `PAYMENT_PARTIALLY_REFUNDED`, `PAYMENT_REFUNDED`;
   - `PAYMENT_CHARGEBACK_REQUESTED`, `PAYMENT_CHARGEBACK_DISPUTE`, `PAYMENT_AWAITING_CHARGEBACK_REVERSAL`.

7. Salve o Webhook. Use a opção de envio/teste do Sandbox, quando disponível, e confira os logs de entrega do Asaas. O endpoint precisa responder diretamente com HTTP 2xx; o Asaas não segue redirecionamentos.
8. Volte ao painel do casamento, marque **Já cadastrei e testei esta URL e este token** e clique **Ativar pagamentos deste casamento**.

O endpoint confere o token antes de aceitar o evento e registra o ID de cada evento para ignorar entregas repetidas. Se a URL ficar indisponível, consulte **Integrações → Webhooks → Logs** no Asaas; falhas repetidas podem pausar a fila.

## 4. Testar uma cobrança ponta a ponta

1. Confirme a presença de um convidado usando o site. Guarde o nome e o WhatsApp exatamente como foram informados.
2. Confira que existe ao menos um presente com valor maior que zero.
3. Abra o site público desse casamento, escolha um presente e clique **Presentear**.
4. Informe nome e WhatsApp usados no RSVP. O servidor confere a presença no banco; um nome/telefone que não corresponda a um RSVP é recusado.
5. O site cria um pedido pendente e redireciona ao Checkout do Asaas, com Pix e cartão de crédito disponíveis. O Checkout é de pagamento único.
6. Conclua uma cobrança de teste no Sandbox. Para cartão, use os dados de teste publicados pelo Asaas; para simular o recebimento Pix, abra a cobrança no painel Sandbox e use a ação de confirmação disponível para aquela cobrança. Não use cartão, CPF ou dinheiro real em testes.
7. Volte ao site pelo redirecionamento. Esse retorno é apenas navegação; não é considerado prova de pagamento.
8. Aguarde o Webhook `CHECKOUT_PAID` ou `PAYMENT_RECEIVED`. Depois disso, confira no site que o presente continua na lista como presenteado e no painel que o pagamento aparece como **Pago**.
9. Teste também cancelamento, expiração, credencial inválida, evento repetido e estorno. O identificador de evento torna o processamento idempotente.
10. Se o convidado enviar uma dedicatória opcional no Checkout, ela aparece na Penseira apenas depois da confirmação do pagamento.

O Sandbox é independente de produção: cadastros, cobranças, chaves e configurações não são compartilhados. Uma cobrança criada não significa que foi paga; a confirmação vem de evento assíncrono do Asaas.

## 5. Ativar produção

1. Cada casal deve ter a própria conta Asaas de produção aprovada e habilitada para receber pagamentos.
2. Na conta de produção, crie uma chave API nova. Não reutilize a chave Sandbox.
3. No painel dos noivos, selecione **Produção**, cole a chave de produção e salve.
4. Copie o token e confira a URL de Webhook. Cadastre/atualize os mesmos eventos na conta de produção; a URL da aplicação não muda, mas a configuração de Webhooks pertence a cada conta/ambiente.
5. Teste a conexão com a conta de produção, confirme o Webhook e só então ative os pagamentos. Faça primeiro uma cobrança de valor baixo com consentimento e valide o recebimento no painel Asaas.
6. Depois do teste, monitore os eventos e os logs de Webhook. Não divulgue a chave, o token ou dados bancários em suporte público.

## 6. O que o módulo faz e regras importantes

- Cada casamento tem credencial, ambiente, token de Webhook e histórico próprios, isolados por `wedding_id` e RLS no PostgreSQL.
- A chave Asaas é criptografada no banco. Ela nunca é devolvida por APIs públicas ou enviada ao navegador de convidados.
- Pagamentos ficam pendentes por até 65 minutos no sistema; o Checkout do Asaas expira em 60 minutos. Um item pendente fica temporariamente reservado.
- O sistema só marca o presente como pago após evento autenticado. O retorno `successUrl` não aprova pagamentos.
- A integração de Checkout disponibilizada agora usa Pix e cartão de crédito, em cobrança avulsa. Boleto, recorrência, parcelamento e split não estão habilitados nesta etapa; estornos e contestações iniciados no Asaas são sincronizados pelos eventos de pagamento configurados.
- Se dois checkouts concorrentes forem pagos para o mesmo presente por uma liquidação tardia, um ficará como **Pago em duplicidade — revisar estorno** para ação manual na conta Asaas.
- Para trocar de chave, informe uma chave nova e teste a conexão outra vez. A rotação do token exige atualizar o valor no Webhook do Asaas antes de reativar os pagamentos.

## 7. Diagnóstico

- **Chave inválida:** confira que ambiente e chave correspondem; Sandbox e produção usam credenciais diferentes.
- **Pagamento indisponível:** confirme que salvou a chave, testou a conexão, cadastrou/testou o Webhook e ativou os pagamentos.
- **Presença não encontrada:** use o mesmo nome e WhatsApp do RSVP; o número é comparado apenas pelos dígitos.
- **Presente reservado:** outro Checkout está em andamento. Aguarde a expiração ou cancelamento recebido pelo Webhook.
- **Checkout criado, presente não marcado:** consulte os logs de Webhook no Asaas e confira URL, token, HTTP 2xx e evento `CHECKOUT_PAID`.
- **Não consigo mostrar novamente o token:** salve a configuração para revelar o token atual ou marque a rotação; se rotacionar, atualize o Webhook do Asaas e teste antes de reativar.
- **Chave não pode ser descriptografada:** restaure o `PAYMENTS_ENCRYPTION_KEY` original. Não gere outro valor para substituir o segredo existente.

## Fontes oficiais

- [Sandbox Asaas](https://docs.asaas.com/docs/sandbox)
- [Chaves de API](https://docs.asaas.com/docs/chaves-de-api)
- [Autenticação da API](https://docs.asaas.com/docs/authentication-2)
- [Asaas Checkout](https://docs.asaas.com/docs/asaas-checkout)
- [Testar pagamentos com cartão](https://docs.asaas.com/docs/testing-credit-card-payment)
- [FAQ e confirmação de pagamentos no Sandbox](https://docs.asaas.com/docs/faq-sandbox-1)
- [Eventos de Checkout](https://docs.asaas.com/docs/checkout-events)
- [Receber eventos e proteger Webhooks](https://docs.asaas.com/docs/receive-asaas-events-at-your-webhook-endpoint)
- [Eventos de pagamento, recebimento, estorno e contestação](https://docs.asaas.com/docs/payment-events)
