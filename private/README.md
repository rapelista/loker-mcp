# Folder private/

Taruh file lampiran (CV, portofolio, transkrip, sertifikat) di sini, lalu daftarkan di
`profile/profile.json` bagian `lampiran` dengan field `"file": "<nama file>"`.

File di folder ini ikut terbundel ke serverless function Vercel, tetapi TIDAK bisa diakses publik
lewat URL. Meski begitu, file ini tetap ikut ter-commit, jadi pastikan repo GitHub-mu **private**.
Kalau tidak mau menyimpan CV di repo, pakai field `"url"` di lampiran (mis. link unduhan langsung).
