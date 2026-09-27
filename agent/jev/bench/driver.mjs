export function scriptedFormDecider() {
  const used=new Set(),radios=new Set();
  const denyRe=/delete|publish|send|purchase|pay|reset|open modal|honeypot/i;
  const valueFor=c=>{
    const label=`${c.what} ${c.name}`.toLowerCase();
    if(/first|given/.test(label))return 'first_name';
    if(/last|surname|family/.test(label))return 'last_name';
    if(c.type==='email'||/email/.test(label))return 'email';
    if(/zip|postal/.test(label))return 'zip_code';
    if(/city/.test(label))return 'city';
    if(/address|street/.test(label))return 'address';
    if(c.type==='tel'||/phone/.test(label))return 'phone';
    if(c.type==='date')return 'date';
    if(c.type==='time')return 'time';
    if(c.type==='number')return 'number';
    if(c.kind==='search')return 'search';
    return 'text';
  };
  // One key format shared by the plan path and the atom path — a control
  // marked used under one shape must stay used under the other, or the
  // fallback pass re-dispatches it (a second checkbox click toggles it off).
  const key=(op,c)=>`${op}|${c.name}|${c.what}|${c.component?.label||''}`;
  const choice=(id,confidence=1)=>({type:'choice',choice:id,probabilities:{[id]:1},confidence});
  return async request=>{
    const answers={goal_met:{type:'noul',probability:0},destructive:{type:'noul',probability:0}};
    const plan=request.plan;
    // Plan mode: one request asks every field at once. Answer each per-field
    // question with the same label-matching rules the single-atom path used.
    if(plan&&plan.items.size){
      let assigned=0;
      for(const [qk,meta] of plan.items){
        const c=meta.control,k=key(meta.op,c);let answer='none';
        if(meta.op==='fill'&&!used.has(k)&&!denyRe.test(c.what)&&!/other record/i.test(c.component?.label||'')){
          const v=valueFor(c);if(request.questions[qk].criteria[v]){answer=v;used.add(k);}
        }else if(meta.op==='select'&&!used.has(k)){
          const firstKey=Object.keys(meta.optionMap||{}).find(k2=>meta.optionMap[k2]>0);
          if(firstKey!==undefined){answer=firstKey;used.add(k);}
        }else if(meta.op==='radio'&&!used.has(k)&&!denyRe.test(c.what)){
          // One group answer dispatches one member click — mark every member
          // used under the click key so the fallback never re-picks a sibling.
          const fk=Object.keys(meta.memberMap||{})[0];
          if(fk){answer=fk;used.add(k);radios.add(c.name);for(const m of meta.members||[])used.add(key('click',m.control));}
        }else if(meta.op==='upload'&&!used.has(k)){
          const fk=Object.keys(request.questions[qk].criteria).find(f=>f!=='none');if(fk){answer=fk;used.add(k);}
        }else if(meta.op==='click'&&!used.has(k)&&!denyRe.test(c.what)
          &&!/other record/i.test(c.component?.label||'')&&!(c.type==='radio'&&radios.has(c.name))){
          answer='check';used.add(k);if(c.type==='radio')radios.add(c.name);
        }
        answers[qk]=choice(answer);
        if(answer!=='none')assigned++;
      }
      answers.submit=choice('none');
      if(assigned>0){answers.action=choice('fill_form');return answers;}
    }
    // Legacy single-atom path (baseline mode, or a page with no assignable fields).
    const controls=request.actions.filter(a=>a.item);
    const allowed=a=>!denyRe.test(a.item.control.what);
    const draft=controls.filter(a=>allowed(a)&&!(/other record/i.test(a.item.control.component?.label||'')));
    let action=draft.find(a=>a.operation==='fill'&&!used.has(key('fill',a.item.control)))
      ||draft.find(a=>a.operation==='select'&&!used.has(key('select',a.item.control))&&a.item.option>0)
      ||draft.find(a=>a.operation==='click'&&['checkbox','radio'].includes(a.item.control.type)&&!used.has(key('click',a.item.control))
        &&(a.item.control.type!=='radio'||!radios.has(a.item.control.name)))
      ||draft.find(a=>a.operation==='upload'&&!used.has(key('upload',a.item.control))
        &&Object.keys(request.questions?.file_value?.criteria||{}).some(k=>k!=='none'))
      ||draft.find(a=>a.operation==='click'&&/save draft|submit|next|continue|finish|complete|accept|click me|click here/i.test(a.item.control.what)&&!used.has(key('click',a.item.control)))
      ||draft.find(a=>a.operation==='press'&&!used.has(key('press',a.item.control))&&a.item.control.kind==='search')
      ||request.actions.find(a=>a.id==='blocked');
    let value='text',fileKey='none';
    if(action?.operation==='upload')fileKey=Object.keys(request.questions?.file_value?.criteria||{}).find(k=>k!=='none')||'none';
    if(action?.item){
      const c=action.item.control;
      if(action.operation==='fill')value=valueFor(c);
      used.add(key(action.operation,c));if(c.type==='radio')radios.add(c.name);
    }
    const picked=action?.id||'blocked';
    return {...answers,action:choice(picked),
      fill_value:choice(value),file_value:choice(fileKey)};
  };
}
