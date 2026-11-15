# Tiehavainnot 🚓📷⛽

Puhelimeen asennettava karttasovellus (PWA), jossa näkyvät:

- 📷 **Kiinteät nopeuskamerat**: OpenStreetMapista, päivittyy kerran vuorokaudessa
- ⛽ **E85-asemat**: OpenStreetMapista + käyttäjien lisäämät
- 🚓 **Poliisihavainnot**, 📸 **peltipoliisiautot** ja ⚠️ **vaarat**: käyttäjien ilmoitukset, jotka vanhenevat automaattisesti (2–3 h)

Lisäksi: nopeusmittari, ääni- ja värinävaroitus kun lähestyt kameraa tai ilmoitusta ajosuunnassa, näyttö pysyy päällä ajon aikana, toimii Android Autosta riippumatta pelkällä puhelimella.

---

## 1. Julkaise sovellus netiin (ilmainen, GitHub Pages)

Sovellus tarvitsee https-osoitteen, jotta GPS toimii.

1. Luo GitHubiin uusi repo, esim. `tiehavainnot` (Public).
2. Lataa kaikki tämän kansion tiedostot repoon (*Add file → Upload files*), myös `icons`-kansio.
3. Repon *Settings → Pages* → *Source: Deploy from a branch* → `main` / `root` → Save.
4. Hetken päästä sovellus on osoitteessa `https://<käyttäjänimi>.github.io/tiehavainnot/`.

## 2. Asenna puhelimeen

1. Avaa osoite **Chromella**.
2. Valikko ⋮ → **Asenna sovellus** / **Lisää aloitusnäytölle**.
3. Salli sijainti, kun sitä kysytään.

## 3. Jaetut ilmoitukset (Firebase, ilmainen)

Ilman tätä ilmoitukset näkyvät vain omassa puhelimessa. Kun haluat, että kaikki käyttäjät näkevät toistensa poliisihavainnot:

1. Mene osoitteeseen https://console.firebase.google.com → **Add project** (Analyticsia ei tarvita).
2. Vasemmalta **Build → Realtime Database → Create database** → sijainniksi *europe-west1* → *Start in locked mode*.
3. **Rules**-välilehdelle liitä tämä ja paina *Publish*:

```json
{
  "rules": {
    "reports": {
      ".read": true,
      "$id": {
        ".write": true,
        ".validate": "newData.hasChildren(['type','lat','lon','t']) && newData.child('lat').isNumber() && newData.child('lon').isNumber() && newData.child('t').isNumber() && newData.child('type').isString() && newData.child('type').val().matches(/^(police|mobilecam|hazard|e85)$/)"
      }
    }
  }
}
```

4. Kopioi tietokannan osoite sivun yläosasta (esim. `https://tiehavainnot-default-rtdb.europe-west1.firebasedatabase.app`).
5. Sovelluksessa ⚙️ → liitä osoite → **Tallenna**. Jokaisen käyttäjän pitää tehdä tämä kerran. Voit myös kirjoittaa osoitteen suoraan `app.js`:n `dbUrl: ''` -kohtaan, jolloin se on valmiina kaikilla.

> Huom: säännöt sallivat kenen tahansa kirjoittaa. Pienelle porukalle se riittää. Jos sovellus leviää laajasti, kannattaa lisätä Firebase-kirjautuminen (anonyymi auth) ja raja ilmoitusten määrälle.

---

## Laillisuus & turvallisuus

- Sovellus käyttää vain karttatietoa ja käyttäjien ilmoituksia, **ei tutkanpaljastusta**. Paljastinlaitteet ovat Suomessa kiellettyjä.
- Ilmoituksiin tallentuu vain tyyppi, sijainti ja aika, ei kuvia, nimiä eikä rekisterikilpiä.
- Kameravaroitukset ovat kiellettyjä mm. Ranskassa, Saksassa ja Norjassa. Kytke ne pois tasovalikosta 🗂️ ulkomailla.
- Älä näpräile puhelinta ajaessa: pidä se telineessä ja anna kyytiläisen tehdä ilmoitukset.
- Karttadata © OpenStreetMap-tekijät, ODbL-lisenssi. Kaikkia E85-asemia ei ole merkitty OSM:ään; puuttuvat voi lisätä ⛽-napilla.

## Tiedostot

| Tiedosto | Mitä |
|---|---|
| `index.html` | Käyttöliittymä |
| `app.js` | Kaikki logiikka (kartta, GPS, varoitukset, ilmoitukset) |
| `style.css` | Ulkoasu (tumma teema) |
| `manifest.json`, `sw.js`, `icons/` | Asennettavuus ja välimuisti |
