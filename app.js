let data = JSON.parse(localStorage.getItem("data") || "{}");

let currentDateKey = "";

const today = new Date();
let year = today.getFullYear();
let month = today.getMonth();

function key(d){
  return d.toISOString().split("T")[0];
}

function render(){
  const cal = document.getElementById("calendar");
  cal.innerHTML = "";

  document.getElementById("title").innerText = `${year}/${month+1}`;

  let income = 0;
  let expense = 0;

  const last = new Date(year, month+1, 0).getDate();

  for(let i=1;i<=last;i++){
    const d = new Date(year, month, i);
    const k = key(d);

    const div = document.createElement("div");
    div.className = "day";

    if(d.getDay()==0 || d.getDay()==6){
      div.classList.add("weekend");
    }

    div.innerHTML = `<div>${i}</div>`;

    if(data[k]){
      let total = 0;
      data[k].forEach(x=>{
        if(x.type==="income") income += x.amount;
        else expense += x.amount;
        total += x.amount;
      });

      div.innerHTML += `<div class="amount">${total}</div>`;
    }

    div.onclick = ()=>{
      currentDateKey = k;
      document.getElementById("modal").style.display = "block";
    };

    cal.appendChild(div);
  }

  document.getElementById("income").innerText = "收入:" + income;
  document.getElementById("expense").innerText = "支出:" + expense;
  document.getElementById("balance").innerText = "結餘:" + (income-expense);
}

function save(){
  const amt = parseInt(document.getElementById("amount").value);
  const type = document.getElementById("type").value;

  if(!amt) return;

  if(!data[currentDateKey]) data[currentDateKey] = [];

  data[currentDateKey].push({
    amount: amt,
    type: type
  });

  localStorage.setItem("data", JSON.stringify(data));

  document.getElementById("modal").style.display = "none";

  render();
}

render();