(function(){
  var S={
    es:{ey:'Auditoria Web y Rediseno - por OYE Creations',h1:'<em>Envia</em> tu URL.<br>Queda <em>optimizado.</em>',sub:'Auditoria completa de SEO, seguridad, rendimiento y accesibilidad - mas un rediseno limpio. Una sola caida. Sin contratos. El codigo es tuyo.'},
    fr:{ey:'Audit Web et Refonte - par OYE Creations',h1:'<em>Deposez</em> votre URL.<br>Soyez <em>optimise.</em>',sub:'Audit complet SEO, securite, performance et accessibilite - plus une refonte propre. Un seul depot. Sans engagement. Vous etes proprietaire du code.'},
    pt:{ey:'Auditoria Web e Reconstrucao - por OYE Creations',h1:'<em>Envie</em> sua URL.<br>Fique <em>otimizado.</em>',sub:'Auditoria completa de SEO, seguranca, desempenho e acessibilidade - mais uma reconstrucao limpa. Uma queda. Sem contrato. O codigo e seu.'},
    de:{ey:'Web-Audit und Neubau - von OYE Creations',h1:'<em>Drop</em> deine URL.<br>Werde <em>optimiert.</em>',sub:'Vollstaendiger SEO-, Sicherheits-, Performance- und Accessibility-Audit - plus ein sauberer Neubau. Ein Drop. Kein Vertrag. Der Code gehoert dir.'}
  };
  fetch('https://bink.oyecreations.com/api/region').then(function(r){return r.json()}).then(function(d){
    var s=S[(d.languageCode||'').split('-')[0]];if(!s)return;
    var el;
    el=document.getElementById('heroEyebrow');if(el)el.textContent=s.ey;
    el=document.getElementById('heroH1');if(el)el.innerHTML=s.h1;
    el=document.getElementById('heroSub');if(el)el.textContent=s.sub;
  }).catch(function(){});
})();
