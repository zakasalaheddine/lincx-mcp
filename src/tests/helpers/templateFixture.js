// Trimmed from a real production template (pddd6d): sections nested in an
// attribute, triple + implicit tags, spaced tags, JS template literals, and an
// inline beforeLoad script — the shapes a naive checker gets wrong.
export const REAL_HTML = `<div class="lincx-root">
  {{#ads}}
  <div class="listicle" data-heading="{{listicle_headline}}" id="{{ adId }}">
    <h2 class="heading">{{{listicle_headline}}}</h2>
    <div class="listicle__list__cta" data-content="{{#cta_list}}{{.}}{{/cta_list}}">
      {{#cta_list}}<a href="{{href}}" data-element="{{{.}}}">{{.}}</a>{{/cta_list}}
    </div>
    {{^cta_text}}<span>no cta</span>{{/cta_text}}
  </div>
  {{/ads}}
  <script data-lincx-hook="beforeLoad">
    window.lincxStandardGrouping(container, ads, tieringEnabled, adFeedCount, { groups: [{ groupKey: 'premium' }] });
    console.warn(\`CTA content "\${content}" does not contain a valid split.\`);
  </script>
</div>`
