<?php
// MarketMind AI — the NIFTY 500 universe split into its four size groups, with NSE's industry for each share.
// Source: niftyindices.com constituent lists (ind_nifty50list, ind_niftynext50list, ind_niftymidcap150list,
// ind_niftysmallcap250list, ind_nifty500list), pulled 11 Nov 2026. NSE rebalances in March and September:
// refresh this file then (or let api/overview.php?action=refresh_universe pull the lists, admin).
//
// Format per group: "<industry index>:<SYMBOL SYMBOL …>|<industry index>:…"

declare(strict_types=1);

const MM_INDUSTRIES = [
    'Automobile and Auto Components', 'Capital Goods', 'Chemicals', 'Construction', 'Construction Materials',
    'Consumer Durables', 'Consumer Services', 'Diversified', 'Fast Moving Consumer Goods', 'Financial Services',
    'Healthcare', 'Information Technology', 'Media Entertainment & Publication', 'Metals & Mining',
    'Oil Gas & Consumable Fuels', 'Power', 'Realty', 'Services', 'Telecommunication', 'Textiles',
];

const MM_GROUPS = [
    'L' => ['name' => 'NIFTY 50', 'size' => 'Large cap', 'index' => '^NSEI'],
    'N' => ['name' => 'NIFTY Next 50', 'size' => 'Large cap', 'index' => '^NSMIDCP'],
    'M' => ['name' => 'NIFTY Midcap 150', 'size' => 'Mid cap', 'index' => 'NIFTYMIDCAP150.NS'],
    'S' => ['name' => 'NIFTY Smallcap 250', 'size' => 'Small cap', 'index' => 'NIFTYSMLCAP250.NS'],
];

const MM_UNIVERSE = [
    'L' => '0:BAJAJ-AUTO EICHERMOT M&M MARUTI TMPV|1:BEL|3:LT|4:GRASIM ULTRACEMCO|5:ASIANPAINT TITAN|6:ETERNAL TRENT|8:HINDUNILVR ITC NESTLEIND TATACONSUM|9:AXISBANK BSE BAJFINANCE BAJAJFINSV HDFCBANK HDFCLIFE ICICIBANK JIOFIN KOTAKBANK SBILIFE SHRIRAMFIN SBIN|10:APOLLOHOSP CIPLA DRREDDY MAXHEALTH SUNPHARMA|11:HCLTECH INFY TCS TECHM|13:ADANIENT HINDALCO JSWSTEEL TATASTEEL|14:COALINDIA ONGC RELIANCE|15:NTPC POWERGRID|17:ADANIPORTS INDIGO|18:BHARTIARTL',
    'N' => '0:BOSCHLTD HYUNDAI MOTHERSON TVSMOTOR|1:ABB CGPOWER CUMMINSIND HAL POWERINDIA MAZDOCK POLYCAB ENRIN SIEMENS TMCV|2:PIDILITIND SOLARINDS|4:AMBUJACEM|6:DMART|8:BRITANNIA GODREJCP VBL|9:BAJAJHLDNG BANKBARODA CANBK CHOLAFIN HDFCAMC IRFC MUTHOOTFIN PFC PNB TATACAP UNIONBANK|10:DIVISLAB TORNTPHARM ZYDUSLIFE|11:LTM WIPRO|13:HINDZINC JINDALSTEL VAML VEDL|14:BPCL GAIL IOC|15:ADANIENSOL ADANIGREEN ADANIPOWER TATAPOWER|16:DLF|18:IDEA',
    'M' => '0:BALKRISIND BHARATFORG ENDURANCE EXIDEIND HEROMOTOCO MRF SCHAEFFLER TIINDIA UNOMINDA|1:AIAENG APLAPOLLO APARINDS ASHOKLEY ASTRAL BDL BHEL COCHINSHIP ESCORTS GVT&D KEI PREMIERENE SUPREMEIND SUZLON THERMAX WAAREEENER|2:COROMANDEL FACT FLUOROCHEM LINDEINDIA PIIND SRF UPL|3:RVNL|4:DALBHARAT JKCEMENT SHREECEM|5:BERGEPAINT BLUESTARCO DIXON HAVELLS KALYANKJIL LGEINDIA VOLTAS|6:NYKAA ITCHOTELS INDHOTEL IRCTC NAUKRI JUBLFOOD LENSKART MEESHO SWIGGY VMM|7:GODREJIND|8:COLPAL DABUR GODFRYPHLP MARICO PATANJALI RADICO UBL UNITDSPR|9:360ONE AUBANK ABCAPITAL AIIL BAJAJHFL BANKINDIA MAHABANK GROWW CRISIL FEDERALBNK GICRE HDBFS HUDCO ICICILIFE ICICIGI ICICIAMC IDFCFIRSTB INDIANB IOB IREDA INDUSINDBK LTF LICHSGFIN LICI M&MFIN MFSL MOTILALOFS MCX NAM-INDIA PAYTM POLICYBZR PIRAMALFIN RECLTD SBICARD SUNDARMFIN TATAINVEST YESBANK|10:ABBOTINDIA AJANTPHARM ALKEM ANTHEM ASTERDM AUROPHARMA BIOCON FORTIS GLAXO GLENMARK MEDANTA IPCALAB LAURUSLABS LUPIN MANKIND NH|11:COFORGE HEXT LTTS MPHASIS OFSS PERSISTENT|13:HINDCOPPER JSL LLOYDSME NMDC NATIONALUM SAIL|14:ATGL HINDPETRO OIL PETRONET|15:JSWENERGY NHPC NLCINDIA NTPCGREEN TORNTPOWER|16:EMBASSY GODREJPROP LODHA OBEROIRLTY PHOENIXLTD PRESTIGE|17:CONCOR GMRAIRPORT JSWINFRA|18:BHARTIHEXA INDUSTOWER TATACOMM|19:KPRMILL PAGEIND',
    'S' => '0:ARE&M APOLLOTYRE ASAHIINDIA ATHERENERG BELRISE CIEINDIA CEATLTD CRAFTSMAN FORCEMOT GABRIEL JBMA JKTYRE MINDACORP MSUMI OLAELEC OLECTRA RKFORGE SHRIPISTON SANSERA SONACOMS TENNIND ZFCVINDIA|1:ACE CPPLUS AZAD BEML CARBORUNIV DATAPATTNS ELECON ELGIEQUIP EMMVEE FINCABLES GALLANTT GRSE GPIL GRAPHITE HBLENGINE HEGAM HONAUT INOXINDIA INOXWIND JINDALSAW JWL JYOTICNC KSB KAYNES KIRLOSBROS KIRLOSENG MTARTECH PTCIL RRKABEL RHIM SCHNEIDER SHYAMMETL SYRMA TDPOWERSYS TEGA TIMKEN TITAGARH TARIL TRITURBINE USHAMART WELCORP ZENTEC|2:AARTIIND AETHER ANURAS ATUL CHAMBLFERT CLEAN DEEPAKFERT DEEPAKNTR HSCL JUBLINGREA NAVINFLUOR PCBL PARADEEP PRIVISCL SUMICHEM SWANCORP TATACHEM|3:AFCONS CEMPRO ENGINERSIN IRB IRCON KPIL KEC NBCC NCC RITES TECHNOE|4:ACC INDIACEM JSWCEMENT NUVOCO RAMCOCEM|5:AMBER BATAINDIA CROMPTON KAJARIACER PGEL THANGAMAYL WHIRLPOOL|6:BLS FIRSTCRY CARTRADE DEVYANI EIHOTEL INDIAMART LEMONTREE PWL TBOTEK URBANCO|8:AWL ABDL AVANTIFEED BALRAMCHIN CCL CUPID DOMS EIDPARRY EMAMILTD GILLETTE HONASA LTFOODS ZYDUSWELL|9:AADHARHFC AAVAS ABSLAMC ANANDRATHI ANGELONE APTUS BANDHANBNK CANFINHOME CANHLIFE CGCL CENTRALBK CDSL CHOICEIN CHOLAHLDNG CUB CAMS CREDITACC FIVESTAR HOMEFIRST IDBI IFCI IIFL IEX JMFINANCIL J&KBANK KARURVYSYA KFINTECH MANAPPURAM NUVAMA PNBHOUSING PINELABS POONAWALLA RBLBANK SAMMAANCAP STARHEALTH NIACL UCOBANK UTIAMC|10:ACUTAAS CAPLIPOINT COHANCE CONCORDBIO LALPATHLAB EMCURE GLAND GRANULES KIMS NATCOPHARM NEULANDLAB ONESOURCE PPLPHARMA POLYMED RAINBOW RUBICON SAILIFE SYNGENE VIJAYA WOCKPHARMA|11:AFFLE BSOFT BBOX CYIENT FRACTAL INTELLECT IKS KPITTECH NETWEB SAGILITY TATAELXSI TATATECH ZENSARTECH|12:PVRINOX PFOCUS SUNTV ZEEL|13:GRAVITA GMDCLTD JAINREC NSLNISP SARDAEN VISL|14:AEGISLOG AEGISVOPAK BHARATCOAL CASTROLIND CHENNPETRO IGL MGL MRPL VOGL|15:ACMESOLAR CESC CLEANMAX JPPOWER NAVA RPOWER SJVN VEDPOWER|16:ABREL ANANTRAJ BAGMANE BRIGADE BIRET SIGNATURE SOBHA|17:CMPDI DELHIVERY FSL GESHIP IGIL MMTC REDINGTON SCI ECLERX|18:HFCL ITI RAILTEL STLTECH TTML TEJASNET|19:TRIDENT VTL WELSPUNLIV',
];

// Sector index on Yahoo used for each industry's trend, zones and strategies (null = Yahoo has no daily history
// for that NSE index, so the call uses the breadth of its shares only). Healthcare uses NIFTY Pharma, and
// Oil & Gas and Power share NIFTY Energy (checked 11 Nov 2026).
// Also the news search words for that industry.
const MM_SECTORS = [
    0 => ['short' => 'Auto', 'index' => '^CNXAUTO', 'news' => 'India auto sector stocks'],
    1 => ['short' => 'Capital Goods', 'index' => null, 'news' => 'India capital goods defence stocks'],
    2 => ['short' => 'Chemicals', 'index' => null, 'news' => 'India chemical stocks'],
    3 => ['short' => 'Construction', 'index' => '^CNXINFRA', 'news' => 'India infrastructure construction stocks'],
    4 => ['short' => 'Cement', 'index' => null, 'news' => 'India cement stocks'],
    5 => ['short' => 'Consumer Durables', 'index' => null, 'news' => 'India consumer durables stocks'],
    6 => ['short' => 'Consumer Services', 'index' => '^CNXCONSUM', 'news' => 'India consumer retail stocks'],
    7 => ['short' => 'Diversified', 'index' => null, 'news' => 'India conglomerate stocks'],
    8 => ['short' => 'FMCG', 'index' => '^CNXFMCG', 'news' => 'India FMCG stocks'],
    9 => ['short' => 'Financials', 'index' => 'NIFTY_FIN_SERVICE.NS', 'news' => 'India banking financial stocks'],
    10 => ['short' => 'Healthcare', 'index' => '^CNXPHARMA', 'news' => 'India pharma healthcare stocks'],
    11 => ['short' => 'IT', 'index' => '^CNXIT', 'news' => 'India IT stocks'],
    12 => ['short' => 'Media', 'index' => null, 'news' => 'India media stocks'],
    13 => ['short' => 'Metals', 'index' => '^CNXMETAL', 'news' => 'India metal stocks'],
    14 => ['short' => 'Oil & Gas', 'index' => '^CNXENERGY', 'news' => 'India oil gas stocks'],
    15 => ['short' => 'Power', 'index' => '^CNXENERGY', 'news' => 'India power sector stocks'],
    16 => ['short' => 'Realty', 'index' => '^CNXREALTY', 'news' => 'India realty stocks'],
    17 => ['short' => 'Services', 'index' => null, 'news' => 'India logistics services stocks'],
    18 => ['short' => 'Telecom', 'index' => null, 'news' => 'India telecom stocks'],
    19 => ['short' => 'Textiles', 'index' => null, 'news' => 'India textile stocks'],
];

// Extra index tiles for the overview
const MM_TILES = [
    ['sym' => '^NSEI', 'name' => 'NIFTY 50'], ['sym' => '^NSMIDCP', 'name' => 'NIFTY Next 50'],
    ['sym' => 'NIFTYMIDCAP150.NS', 'name' => 'Midcap 150'], ['sym' => 'NIFTYSMLCAP250.NS', 'name' => 'Smallcap 250'],
    ['sym' => '^CRSLDX', 'name' => 'NIFTY 500'], ['sym' => '^NSEBANK', 'name' => 'Bank NIFTY'],
    ['sym' => '^CNXPSUBANK', 'name' => 'PSU Bank'], ['sym' => '^BSESN', 'name' => 'SENSEX'], ['sym' => '^INDIAVIX', 'name' => 'India VIX'],
];

/** @return array<string, array{g:string, i:int}> symbol => group + industry */
function mm_universe(): array {
    static $u = null;
    if ($u !== null) return $u;
    $u = [];
    foreach (MM_UNIVERSE as $g => $line) {
        foreach (explode('|', $line) as $part) {
            [$i, $syms] = explode(':', $part, 2);
            foreach (explode(' ', $syms) as $s) if ($s !== '') $u[$s] = ['g' => $g, 'i' => (int) $i];
        }
    }
    return $u;
}
