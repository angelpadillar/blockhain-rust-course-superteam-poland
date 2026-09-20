/** Independent check of the last visible cart and final checkout snapshot. */
export function verifyShoppingEvidence(run,items,maxPln) {
  const cart=run.steps.map(s=>s.after?.split('heading "Twoje zamówienie"')[1]?.split('heading "Współpraca"')[0])
    .filter(s=>s&&/paragraph: \d+ produkt/.test(s)).at(-1)||'';
  const units=items.reduce((n,i)=>n+i.qty,0);
  const cartUnits=Number(cart.match(/paragraph: (\d+) produkt/)?.[1]);
  const rows=items.map(item=>{
    const marker=`paragraph: ${item.query}\n`;
    const row=cart.includes(marker)?cart.split(marker)[1]?.split('- paragraph:')[0]:'';
    const qty=Number(row?.match(/- status:\s*\n\s*- generic: "(\d+)"/)?.[1]);
    return {product:item.query,expected:item.qty,observed:qty||null,matched:qty===item.qty};
  });
  const final=run.finalSnapshot||'';
  const totalText=final.match(/paragraph: ŁĄCZNIE\s*\n\s*- paragraph: ([\d\s,.]+) zł/)?.[1];
  const totalPln=totalText?Number(totalText.replace(/\s/g,'').replace(',','.')):null;
  const checkoutVisible=/heading "Podsumowanie zamówienia"/.test(final)&&/button "Zamów i zapłać"/.test(final);
  const checkoutUnits=Number(final.match(/paragraph: "(\d+) prod\. z:/)?.[1]);
  const correctCart=cartUnits===units&&rows.every(r=>r.matched);
  const withinBudget=totalPln!==null&&totalPln<=maxPln;
  return {passed:run.stopped==='done'&&correctCart&&checkoutVisible&&checkoutUnits===units&&withinBudget,
    correctCart,checkoutVisible,checkoutUnits:checkoutUnits||null,totalPln,withinBudget,rows};
}
