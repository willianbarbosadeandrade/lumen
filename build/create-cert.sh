#!/bin/bash
# Cria (uma única vez) o certificado autoassinado "Lumen Dev" no Keychain de login.
# Com ele, todo build do Lumen tem a mesma assinatura e o macOS mantém as
# permissões (tela, microfone, acessibilidade) entre um build e outro.
set -e
NAME="Lumen Dev"
if security find-identity -p codesigning 2>/dev/null | grep -q "\"$NAME\""; then
  echo "  • certificado \"$NAME\" já existe"
  exit 0
fi
echo "  • criando certificado de assinatura \"$NAME\"…"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/cert.cnf" <<CNF
[ req ]
distinguished_name = dn
x509_extensions = ext
prompt = no
[ dn ]
CN = $NAME
[ ext ]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF
# /usr/bin/openssl (LibreSSL do macOS) gera um .p12 que o Keychain aceita sem ajustes.
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -config "$TMP/cert.cnf" 2>/dev/null
/usr/bin/openssl pkcs12 -export -name "$NAME" -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -out "$TMP/cert.p12" -passout pass:lumen
security import "$TMP/cert.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P lumen -T /usr/bin/codesign >/dev/null
echo "  • certificado \"$NAME\" criado"
