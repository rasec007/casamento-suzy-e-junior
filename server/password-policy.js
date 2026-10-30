export function validRegistrationPassword(password) {
  return typeof password==='string' && password.length>=12 && password.length<=200 && /\p{L}/u.test(password) && /\p{N}/u.test(password) && /\p{Lu}/u.test(password) && /[^\p{L}\p{N}\s]/u.test(password);
}
