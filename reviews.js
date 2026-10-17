/* Hill Stream — guest reviews.
 *
 * The shape here is exactly what the Google Places API returns, so going live
 * is a swap of one function, not a redesign.
 *
 * The official Places API returns a maximum of FIVE reviews, chosen by Google
 * as the most relevant, with no sorting or pagination. This file holds SIX at
 * the client's request, so note the ceiling: five is all the Places endpoint
 * will ever hand back. To show a sixth you need the Google Business Profile
 * API (an approval process, several weeks) or your own collected reviews
 * clearly labelled as such — do not present non-Google text under Google
 * attribution.
 *
 * Going live — the browser must never hold the API key, so this call belongs
 * on your server:
 *
 *   GET https://places.googleapis.com/v1/places/{PLACE_ID}
 *       ?fields=rating,userRatingCount,reviews
 *       &key={SERVER_SIDE_KEY}
 *
 *   Cache the response (Google's terms allow up to 30 days), return it to the
 *   page from your own endpoint, and keep the "Reviews from Google" attribution
 *   and the link back to the listing — both are required. Review text must be
 *   shown as written; do not edit or reorder it.
 */
(function () {
  var PLACE_ID = 'ChIJ_DEMO_PLACE_ID_HILL_STREAM';

  /* Place-level figures — Places API: rating, userRatingCount. */
  var PLACE = {
    rating: 4.8,
    total: 214,
    url: 'https://maps.google.com/?cid=DEMO',
    /* Places does not return a histogram; this comes from your Business
       Profile, or drop the breakdown block if you do not have it. */
    distribution: { 5: 178, 4: 26, 3: 7, 2: 2, 1: 1 }
  };

  /* Demo stand-ins, one per field the API sends. */
  var REVIEWS = [
    {
      author_name: 'Ananya Rao',
      profile_photo_url: '',
      rating: 5,
      relative_time_description: 'a month ago',
      text: 'Third stay and the first time I have written one of these. I slept with the doors open for four nights and heard nothing but the water. The staff remembered how I take my tea from last year, which tells you the kind of place it is. Ask for a Stream View Room if you can get one.'
    },
    {
      author_name: 'Sam Oyelaran',
      profile_photo_url: '',
      rating: 5,
      relative_time_description: '2 months ago',
      text: 'Came for two nights on the way to Auli and wished I had booked five. Dinner is at one long table at eight and you eat with whoever else is staying, which sounds like a nightmare and turns out to be the best part. No menu, no choosing, and the kafuli was the best thing I ate in India.'
    },
    {
      author_name: 'Ines Marchetti',
      profile_photo_url: '',
      rating: 5,
      relative_time_description: '3 months ago',
      text: 'Did the three-day reset. The consultation before anything gets booked is not a formality — the doctor moved two treatments I had picked and was right to. Yoga at half six on the deck in the cold is the thing I still think about.'
    },
    {
      author_name: 'Devlin Marsh',
      profile_photo_url: '',
      rating: 4,
      relative_time_description: '4 months ago',
      text: 'The place is lovely and the food is genuinely excellent. Two honest notes: the last two kilometres of road are rough and my taxi driver was not pleased, so take them up on the transfer. And mobile signal below the stream is nothing at all — fine if you know, less fine if you have a call booked.'
    },
    {
      author_name: 'Hana Ito',
      profile_photo_url: '',
      rating: 5,
      relative_time_description: '5 months ago',
      text: 'Forty-four rooms and it feels like a dozen. Nobody manages you. I walked, I ate, I sat on the verandah in the rain for two hours and that was the whole day. Worth the drive from Delhi.'
    },
    {
      author_name: 'Rohit Bhandari',
      profile_photo_url: '',
      rating: 5,
      relative_time_description: '6 months ago',
      text: 'Booked it for my parents and came along, which meant I saw it through their eyes. Steps are the one thing to know — the walk from reception down to the lower rooms is real, and they moved us up without being asked twice. My mother has talked about the kafuli every week since.'
    }
  ];

  function get() {
    return { place: JSON.parse(JSON.stringify(PLACE)), reviews: REVIEWS.slice() };
  }

  /* Replace get() with this once your endpoint is up. Point it at YOUR server,
     never at Google directly from the browser. */
  function fetchFromServer(endpoint) {
    return fetch(endpoint || '/api/reviews')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        return {
          place: { rating: d.rating, total: d.userRatingCount, url: d.googleMapsUri, distribution: null },
          reviews: (d.reviews || []).map(function (r) {
            return {
              author_name: r.authorAttribution && r.authorAttribution.displayName,
              profile_photo_url: r.authorAttribution && r.authorAttribution.photoUri,
              rating: r.rating,
              relative_time_description: r.relativePublishTimeDescription,
              text: r.originalText ? r.originalText.text : (r.text && r.text.text)
            };
          })
        };
      });
  }

  window.HSReviews = { PLACE_ID: PLACE_ID, get: get, fetchFromServer: fetchFromServer };
})();
