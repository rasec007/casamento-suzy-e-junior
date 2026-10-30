import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validRegistrationPassword } from '../server/password-policy.js';

test('registration password requires length, a letter, a number, uppercase and a special character',()=>{
  assert.equal(validRegistrationPassword('SenhaSegura123!'),true);
  assert.equal(validRegistrationPassword('ÁrvoreSegura1!'),true);
  for(const password of ['Senha1!','senhasegura1!','SenhaSegura!!','SenhaSegura12','1234567890!@', 'SenhaSegura1 ', '', null]) assert.equal(validRegistrationPassword(password),false,String(password));
  assert.equal(validRegistrationPassword('A1!'+ 'x'.repeat(198)),false);
});
