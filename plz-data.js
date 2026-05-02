'use strict';

// Lookup-Tabelle: 2-stellige PLZ-Präfixe → ungefähre Koordinaten (lat, lon)
// Reicht für Community-Umkreis-Suche (±5 km Genauigkeit)
const PLZ_LOOKUP = {
  '01': [51.05, 13.74],  // Dresden
  '02': [51.15, 14.98],  // Görlitz
  '03': [51.76, 14.33],  // Cottbus
  '04': [51.34, 12.37],  // Leipzig
  '06': [51.48, 11.97],  // Halle
  '07': [50.88, 12.08],  // Gera
  '08': [50.72, 12.50],  // Zwickau
  '09': [50.83, 12.92],  // Chemnitz
  '10': [52.52, 13.41],  // Berlin Mitte
  '11': [52.52, 13.41],  // Berlin
  '12': [52.45, 13.46],  // Berlin Süd
  '13': [52.57, 13.33],  // Berlin Nord
  '14': [52.40, 13.04],  // Potsdam
  '15': [52.35, 14.55],  // Frankfurt/Oder
  '16': [52.83, 13.00],  // Neuruppin
  '17': [53.85, 12.14],  // Neubrandenburg
  '18': [54.09, 12.13],  // Rostock
  '19': [53.63, 11.42],  // Schwerin
  '20': [53.57, 10.01],  // Hamburg
  '21': [53.47, 10.22],  // Hamburg Süd
  '22': [53.60, 9.89],   // Hamburg West
  '23': [53.87, 10.69],  // Lübeck
  '24': [54.32, 10.13],  // Kiel
  '25': [54.19, 9.10],   // Heide
  '26': [53.14, 8.21],   // Oldenburg
  '27': [53.54, 8.58],   // Bremerhaven
  '28': [53.08, 8.80],   // Bremen
  '29': [53.25, 10.41],  // Lüneburg
  '30': [52.37, 9.73],   // Hannover
  '31': [52.10, 9.38],   // Hameln
  '32': [52.02, 8.53],   // Herford
  '33': [51.72, 8.75],   // Paderborn
  '34': [51.32, 9.50],   // Kassel
  '35': [50.57, 8.68],   // Gießen
  '36': [50.55, 9.68],   // Fulda
  '37': [51.54, 9.93],   // Göttingen
  '38': [52.27, 10.52],  // Braunschweig
  '39': [52.13, 11.63],  // Magdeburg
  '40': [51.23, 6.79],   // Düsseldorf
  '41': [51.19, 6.44],   // Mönchengladbach
  '42': [51.27, 7.19],   // Wuppertal
  '44': [51.51, 7.47],   // Dortmund
  '45': [51.46, 7.01],   // Essen
  '46': [51.67, 6.62],   // Gelsenkirchen
  '47': [51.43, 6.76],   // Duisburg
  '48': [51.96, 7.63],   // Münster
  '49': [52.28, 8.05],   // Osnabrück
  '50': [50.93, 6.96],   // Köln
  '51': [50.94, 7.00],   // Köln Ost
  '52': [50.78, 6.08],   // Aachen
  '53': [50.74, 7.10],   // Bonn
  '54': [49.75, 6.64],   // Trier
  '55': [49.99, 8.27],   // Mainz
  '56': [50.36, 7.60],   // Koblenz
  '57': [50.90, 7.98],   // Siegen
  '58': [51.37, 7.47],   // Hagen
  '59': [51.54, 7.69],   // Unna
  '60': [50.11, 8.68],   // Frankfurt
  '61': [50.23, 8.62],   // Frankfurt Nord
  '63': [50.00, 8.97],   // Hanau
  '64': [49.87, 8.65],   // Darmstadt
  '65': [50.08, 8.24],   // Wiesbaden
  '66': [49.23, 7.00],   // Saarbrücken
  '67': [49.44, 7.77],   // Kaiserslautern
  '68': [49.49, 8.47],   // Mannheim
  '69': [49.40, 8.69],   // Heidelberg
  '70': [48.78, 9.18],   // Stuttgart
  '71': [48.89, 9.19],   // Stuttgart Nord
  '72': [48.52, 9.06],   // Tübingen
  '73': [48.78, 9.83],   // Göppingen
  '74': [49.14, 9.22],   // Heilbronn
  '75': [48.89, 8.70],   // Pforzheim
  '76': [49.01, 8.40],   // Karlsruhe
  '77': [48.48, 7.95],   // Offenburg
  '78': [47.96, 8.48],   // Villingen
  '79': [47.99, 7.84],   // Freiburg
  '80': [48.14, 11.58],  // München
  '81': [48.11, 11.61],  // München Ost
  '82': [47.99, 11.34],  // Starnberg
  '83': [47.86, 12.12],  // Rosenheim
  '84': [48.40, 12.57],  // Landshut
  '85': [48.76, 11.43],  // Ingolstadt
  '86': [48.37, 10.90],  // Augsburg
  '87': [47.73, 10.32],  // Kempten
  '88': [47.78, 9.62],   // Ravensburg
  '89': [48.40, 9.99],   // Ulm
  '90': [49.45, 11.08],  // Nürnberg
  '91': [49.30, 10.57],  // Ansbach
  '92': [49.47, 12.16],  // Weiden
  '93': [49.02, 12.10],  // Regensburg
  '94': [48.57, 13.45],  // Passau
  '95': [49.95, 11.58],  // Bayreuth
  '96': [49.90, 10.90],  // Bamberg
  '97': [49.80, 9.94],   // Würzburg
  '98': [50.68, 10.93],  // Suhl
  '99': [50.98, 11.03],  // Erfurt
};

/**
 * Haversine-Formel: Entfernung zwischen zwei Koordinaten in km
 */
function haversineKm(lat1, lon1, lat2, lon2) {
    const R    = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a    = Math.sin(dLat / 2) ** 2
               + Math.cos(lat1 * Math.PI / 180)
               * Math.cos(lat2 * Math.PI / 180)
               * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Entfernung zwischen zwei PLZ in km.
 * Gibt null zurück wenn eine PLZ unbekannt ist.
 */
function plzDistanzKm(plz1, plz2) {
    if (!plz1 || !plz2 || plz1.length < 2 || plz2.length < 2) return null;
    const k1 = PLZ_LOOKUP[plz1.slice(0, 2)];
    const k2 = PLZ_LOOKUP[plz2.slice(0, 2)];
    if (!k1 || !k2) return null;
    return haversineKm(k1[0], k1[1], k2[0], k2[1]);
}

module.exports = { plzDistanzKm, PLZ_LOOKUP };
