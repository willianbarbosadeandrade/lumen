// Assina o Lumen depois do empacotamento.
//
// Por que isso importa: o macOS guarda as permissões (tela, microfone, acessibilidade)
// pela assinatura do app. Com assinatura ad-hoc ("-"), cada rebuild gera uma assinatura
// nova e o macOS passa a tratar o app como outro — o botão fica ligado em Ajustes, mas
// a permissão não vale para o app novo. Com um certificado fixo, a permissão sobrevive
// aos rebuilds.
//
// Ordem de escolha da identidade:
//   1. variável LUMEN_SIGN_IDENTITY
//   2. um certificado válido no Keychain (Developer ID / Apple Development)
//   3. o certificado autoassinado "Lumen Dev" (veja o README)
//   4. ad-hoc ("-")
const { execFileSync } = require('node:child_process')
const path = require('node:path')

function identities(validOnly) {
  try {
    const args = ['find-identity', '-p', 'codesigning']
    if (validOnly) args.splice(1, 0, '-v')
    return execFileSync('security', args, { encoding: 'utf8' })
  } catch {
    return ''
  }
}

function pickIdentity() {
  if (process.env.LUMEN_SIGN_IDENTITY) return process.env.LUMEN_SIGN_IDENTITY
  const valid = identities(true).match(/"((?:Developer ID Application|Apple Development)[^"]+)"/)
  if (valid) return valid[1]
  if (/"Lumen Dev"/.test(identities(false))) return 'Lumen Dev'
  return '-'
}

exports.default = async function sign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const entitlements = path.join(__dirname, 'entitlements.mac.plist')
  const identity = pickIdentity()
  console.log(`  • signing (Lumen)  identity=${identity === '-' ? 'ad-hoc (permissões resetam a cada build)' : identity}`)
  // Pastas sincronizadas com o iCloud (ex.: ~/Documents) colam atributos estendidos nos arquivos,
  // e o codesign recusa ("resource fork, Finder information, or similar detritus not allowed").
  execFileSync('xattr', ['-cr', app], { stdio: 'inherit' })
  execFileSync(
    'codesign',
    ['--force', '--deep', '--options', 'runtime', '--entitlements', entitlements, '--sign', identity, app],
    { stdio: 'inherit' }
  )
  execFileSync('codesign', ['--verify', '--deep', app], { stdio: 'inherit' })
}
