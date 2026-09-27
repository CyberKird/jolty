/** Local hints only. No model request is made while the user types. */
export function usageRisk(text: string, images: number, video: number): string | undefined {
  if (video > 0) return `Ai atașat ${video === 1 ? 'un video' : `${video} videouri`}. Extragerea de cadre, transcrierea audio și analiza pot consuma tokeni suplimentari.`
  const request = /(?:^|[^\p{L}])(adaug[ăa]?|implementeaz[ăa]?|construie[șs]te|creeaz[ăa]?|make|build|implement|add)(?=$|[^\p{L}])/iu
  const recurring = /(?:^|[^\p{L}])(mereu|automat|automate|every|each|fiecare|continu|permanent|background|fundal|periodic|realtime|real.time|cron|monitoriz)/iu
  const model = /(?:^|[^\p{L}])(model|agent|ai|api|llm|analiz|rezum|transcri|gener|traduc|classif|voice|audio|video)/iu
  if (request.test(text) && recurring.test(text) && model.test(text)) {
    return 'Această funcție poate porni apeluri repetate către modele și crește consumul. Cere declanșare manuală, plafon de tokeni sau oprire automată când nu o folosești.'
  }
  if (text.length > 16000) return 'Mesajul este foarte lung și va consuma mulți tokeni la intrare. Un rezumat păstrează de obicei aceeași cerință cu un cost mai mic.'
  if (images >= 5) return 'Multe imagini într-un mesaj pot crește consumul. Trimite doar cadrele necesare pentru răspuns.'
  return undefined
}
