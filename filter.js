let d='';
process.stdin.on('data',c=>d+=c);
process.stdin.on('end',()=>{
  const lines=d.split('\n');
  let inParity=false;
  lines.forEach(l=>{
    if(l.includes('Run Parity Test'))inParity=true;
    if(inParity && l.trim().length>0) console.log(l);
  });
});
