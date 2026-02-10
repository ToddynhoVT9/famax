# Create your views here.
from django.shortcuts import render
from .models import Topic

def home(request):
    topics = Topic.objects.all().order_by("name")
    return render(request, "forum/home.html", {"topics": topics})